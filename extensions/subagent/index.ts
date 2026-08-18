import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";

const MAX_HANDOFF_BYTES = 12 * 1024;
const HANDOFF_INSTRUCTION =
	"Return only a concise final handoff: findings, exact file references, and actionable conclusions. Omit narration, tool transcripts, and repeated task text.";

const BackgroundAgentParams = Type.Object({
	agent: Type.String({ description: "scout, planner, reviewer, worker, or a user agent" }),
	task: Type.String({ description: "Independent task to run" }),
	cwd: Type.Optional(Type.String({ description: "Child working directory; defaults to the parent CWD" })),
});

interface ChildRun {
	abort: () => void;
}

export function truncateUtf8(text: string, maxBytes = MAX_HANDOFF_BYTES): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;

	let marker = "";
	let prefixBytes = maxBytes;
	for (let attempt = 0; attempt < 3; attempt++) {
		const omitted = bytes.length - prefixBytes;
		marker = `\n\n[truncated: ${omitted} bytes omitted]`;
		prefixBytes = Math.max(0, maxBytes - Buffer.byteLength(marker));
	}
	const prefix = bytes.subarray(0, prefixBytes).toString("utf8").replace(/�$/u, "");
	return `${prefix}${marker}`;
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	if (currentScript && !currentScript.startsWith("/$bunfs/root/") && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...args] };
	}
	const executable = path.basename(process.execPath).toLowerCase();
	return /^(node|bun)(\.exe)?$/.test(executable)
		? { command: "pi", args }
		: { command: process.execPath, args };
}

async function writeSystemPrompt(agent: AgentConfig): Promise<{ dir: string; file: string }> {
	const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-background-agent-"));
	const file = path.join(dir, "system.md");
	const handoffInstruction = agent.name === "reviewer" ? "" : `\n\n${HANDOFF_INSTRUCTION}`;
	const systemPrompt = agent.systemPrompt.replaceAll(
		"{{REVIEW_SKILL_DIR}}",
		path.join(import.meta.dirname, "reviewer-skill"),
	);
	await fs.promises.writeFile(file, `${systemPrompt.trim()}${handoffInstruction}\n`, {
		encoding: "utf8",
		mode: 0o600,
	});
	return { dir, file };
}

async function runAgent(
	agent: AgentConfig,
	task: string,
	ctx: ExtensionContext,
	cwd: string,
	onSpawn: (run: ChildRun) => void,
): Promise<string> {
	const args = ["--mode", "json", "-p", "--no-session"];
	const model = agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	if (model) args.push("--model", model);
	if (!agent.model && ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	const temp = await writeSystemPrompt(agent);
	args.push("--append-system-prompt", temp.file, `Task: ${task}`);

	try {
		return await new Promise<string>((resolve, reject) => {
			const invocation = getPiInvocation(args);
			const child = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});
			let stderr = "";
			let buffer = "";
			let finalOutput = "";
			let aborted = false;

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: unknown; message?: unknown };
				try {
					event = JSON.parse(line) as { type?: unknown; message?: unknown };
				} catch {
					return;
				}
				if (event.type !== "message_end" || typeof event.message !== "object" || event.message === null)
					return;
				const message = event.message as { role?: unknown; content?: unknown };
				if (message.role !== "assistant" || !Array.isArray(message.content)) return;
				const textBlocks: string[] = [];
				for (const part of message.content) {
					if (typeof part === "object" && part !== null && "type" in part && "text" in part) {
						const block = part as { type?: unknown; text?: unknown };
						if (block.type === "text" && typeof block.text === "string") textBlocks.push(block.text);
					}
				}
				if (textBlocks.length > 0) finalOutput = textBlocks.join("\n\n");
			};

			onSpawn({
				abort: () => {
					aborted = true;
					child.kill("SIGTERM");
					setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
				},
			});

			child.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = truncateUtf8(stderr + chunk.toString(), MAX_HANDOFF_BYTES);
			});
			child.on("error", reject);
			child.on("close", (code) => {
				if (buffer) processLine(buffer);
				if (aborted) return reject(new Error("aborted"));
				if (code !== 0) return reject(new Error(stderr.trim() || `child exited ${code}`));
				resolve(finalOutput || "No final assistant output returned.");
			});
		});
	} finally {
		await fs.promises.rm(temp.dir, { recursive: true, force: true });
	}
}

function setRunStatus(ctx: ExtensionContext, count: number): void {
	try {
		ctx.ui.setStatus(
			"pi-core-background-agents",
			count > 0 ? `⚙ ${count} agent${count === 1 ? "" : "s"}` : undefined,
		);
	} catch {
		// The parent session may have been replaced while a child was exiting.
	}
}

export default function backgroundAgents(pi: ExtensionAPI): void {
	const runs = new Map<string, ChildRun>();

	pi.on("session_shutdown", () => {
		for (const run of runs.values()) run.abort();
		runs.clear();
	});

	pi.registerTool({
		name: "background_agent",
		label: "Background Agent",
		description:
			"Delegate independent work without blocking. Returns now; the concise final handoff arrives automatically. Never poll. Bundled: scout, planner, reviewer, worker.",
		parameters: BackgroundAgentParams,

		async execute(_id, params, _signal, _update, ctx) {
			const agents = discoverAgents(ctx.cwd, "user").agents;
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent) {
				throw new Error(`Unknown agent. Available: ${agents.map((item) => item.name).join(", ") || "none"}.`);
			}

			const cwd = path.resolve(ctx.cwd, params.cwd ?? ctx.cwd);
			if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) {
				throw new Error(`Invalid child working directory: ${cwd}`);
			}

			const runId = randomUUID();
			void runAgent(agent, params.task, ctx, cwd, (run) => {
				runs.set(runId, run);
				setRunStatus(ctx, runs.size);
			})
				.then((output) => {
					pi.sendMessage(
						{
							customType: "pi-core-background-agent-result",
							content: truncateUtf8(`agent: ${agent.name}\nstatus: complete\n\n${output}`),
							display: true,
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
				})
				.catch((error: unknown) => {
					if (error instanceof Error && error.message === "aborted") return;
					pi.sendMessage(
						{
							customType: "pi-core-background-agent-result",
							content: truncateUtf8(
								`agent: ${agent.name}\nstatus: failed\nerror: ${error instanceof Error ? error.message : String(error)}`,
							),
							display: true,
						},
						{ deliverAs: "steer", triggerTurn: true },
					);
				})
				.finally(() => {
					runs.delete(runId);
					setRunStatus(ctx, runs.size);
				});

			return {
				content: [
					{ type: "text", text: `${agent.name} started in background; result will arrive automatically.` },
				],
				details: {},
			};
		},
	});
}
