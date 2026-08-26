import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import type { SubagentLimits } from "./limits.ts";
import { truncateUtf8 } from "./limits.ts";
import { type ChildLineage, encodeChildLineage, type PendingQuestion, RpcEventTracker } from "./protocol.ts";
import { createTmuxObserver } from "./tmux.ts";

const HANDOFF_INSTRUCTION =
	"Return only a concise final handoff: findings, exact file references, and actionable conclusions. Omit narration, tool transcripts, and repeated task text.";

export const SUBAGENT_EXTENSION_PATH = path.join(import.meta.dirname, "index.ts");

export interface ChildHandle {
	abort(): void;
	message(text: string): void;
	reply(questionId: string, text: string): void;
}

export interface RunRpcAgentOptions {
	agent: AgentConfig;
	task: string;
	cwd: string;
	ctx: ExtensionContext;
	lineage: ChildLineage;
	limits: SubagentLimits;
	model?: string;
	thinking?: string;
	onSpawn(handle: ChildHandle): void;
	onQuestion(question: PendingQuestion): void;
	onStatus(status: string): void;
}

export function parentReplyCommand(text: string, idle: boolean): Record<string, unknown> {
	return {
		type: "prompt",
		message: `Parent reply: ${text}\n\nContinue the assigned task using this answer.`,
		...(idle ? {} : { streamingBehavior: "steer" }),
	};
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
	const systemPrompt = agent.systemPrompt.replaceAll(
		"{{REVIEW_SKILL_DIR}}",
		path.join(import.meta.dirname, "reviewer-skill"),
	);
	const delegation = agent.children?.length
		? `\nYou may delegate only to these named child agents: ${agent.children.join(", ")}.`
		: "";
	await fs.promises.writeFile(
		file,
		`${systemPrompt.trim()}\n\n${HANDOFF_INSTRUCTION}\nUse ask_parent for one blocking question instead of guessing.${delegation}\n`,
		{ encoding: "utf8", mode: 0o600 },
	);
	return { dir, file };
}

function writeRpc(child: ChildProcessWithoutNullStreams, command: Record<string, unknown>): void {
	if (!child.stdin.writable) throw new Error("agent input is closed");
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

export function buildChildTools(agent: AgentConfig, lineage: ChildLineage): string[] | undefined {
	if (!agent.tools?.length) return undefined;
	const tools = new Set(agent.tools);
	tools.add("ask_parent");
	if (lineage.allowedChildren.length > 0 && lineage.depth < lineage.limits.maxDepth) {
		tools.add("background_agent");
		tools.add("agent_control");
	}
	return [...tools];
}

export function buildChildArgs(
	options: Pick<RunRpcAgentOptions, "agent" | "ctx" | "lineage" | "model" | "thinking">,
	systemPromptFile: string,
	extensionPath = SUBAGENT_EXTENSION_PATH,
): string[] {
	const args = ["--mode", "rpc", "--no-session", "--extension", path.resolve(extensionPath)];
	const model =
		options.model ??
		options.agent.model ??
		(options.ctx.model ? `${options.ctx.model.provider}/${options.ctx.model.id}` : undefined);
	if (model) args.push("--model", model);
	const thinking = options.thinking ?? (!options.agent.model ? options.ctx.thinkingLevel : undefined);
	if (thinking) args.push("--thinking", thinking);
	const tools = buildChildTools(options.agent, options.lineage);
	if (tools) args.push("--tools", tools.join(","));
	args.push("--append-system-prompt", systemPromptFile);
	return args;
}

export async function runRpcAgent(options: RunRpcAgentOptions): Promise<string> {
	const temp = await writeSystemPrompt(options.agent);
	const args = buildChildArgs(options, temp.file);
	const observer = createTmuxObserver({ id: options.lineage.runId, agent: options.agent.name });

	try {
		return await new Promise<string>((resolve, reject) => {
			const invocation = getPiInvocation(args);
			const child = spawn(invocation.command, invocation.args, {
				cwd: options.cwd,
				env: {
					...process.env,
					PI_CORE_SUBAGENT_CONTEXT: encodeChildLineage(options.lineage),
				},
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
			const tracker = new RpcEventTracker(options.limits.questionBytes);
			let stderr = "";
			let buffer = "";
			let settled = false;
			let aborted = false;
			let idle = false;
			let forceKill: NodeJS.Timeout | undefined;

			const finish = (error?: Error, output?: string) => {
				if (settled) return;
				settled = true;
				if (forceKill) clearTimeout(forceKill);
				child.kill("SIGTERM");
				observer.close();
				if (error) reject(error);
				else resolve(output || "No final assistant output returned.");
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let raw: unknown;
				try {
					raw = JSON.parse(line);
				} catch {
					return;
				}
				try {
					if (
						raw &&
						typeof raw === "object" &&
						(raw as { type?: unknown }).type === "response" &&
						(raw as { success?: unknown }).success === false
					) {
						const error = (raw as { error?: unknown }).error;
						finish(new Error(typeof error === "string" ? error : "Child RPC command failed."));
						return;
					}
					const event = tracker.consume(raw);
					if (!event) return;
					if (event.type === "question") {
						options.onQuestion(event.question);
						options.onStatus("waiting for parent reply");
						observer.status("waiting for parent reply");
					} else if (event.type === "nested_started") {
						options.onStatus("waiting for delegated work");
						observer.status(`delegated ${event.id}`);
					} else if (event.type === "nested_finished") {
						observer.status(`delegation ${event.id} returned`);
					} else if (event.type === "settled") {
						idle = true;
						if (event.waiting) return;
						if (event.error) finish(new Error(event.error));
						else finish(aborted ? new Error("stopped") : undefined, event.output);
					}
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			};

			options.onSpawn({
				abort() {
					if (settled) return;
					aborted = true;
					try {
						writeRpc(child, { type: "abort" });
					} catch {
						child.kill("SIGTERM");
					}
					forceKill = setTimeout(() => child.kill("SIGKILL"), 1_000);
					forceKill.unref();
				},
				message(text: string) {
					writeRpc(child, idle ? { type: "prompt", message: text } : { type: "steer", message: text });
					idle = false;
				},
				reply(questionId: string, text: string) {
					writeRpc(child, parentReplyCommand(text, idle));
					tracker.acceptReply(questionId);
					idle = false;
					options.onStatus("running");
					observer.status("parent replied; running");
				},
			});

			child.stdout.on("data", (chunk: Buffer) => {
				buffer += chunk.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) processLine(line);
			});
			child.stderr.on("data", (chunk: Buffer) => {
				stderr = truncateUtf8(stderr + chunk.toString(), options.limits.handoffBytes);
			});
			child.on("error", (error) => finish(error));
			child.on("close", (code) => {
				if (buffer) processLine(buffer);
				if (settled) return;
				if (aborted) return finish(new Error("stopped"));
				finish(new Error(stderr.trim() || `agent exited ${code ?? "unknown"}`));
			});

			options.onStatus("running");
			observer.status("running");
			if (!aborted) writeRpc(child, { type: "prompt", message: `Task: ${options.task}` });
		});
	} finally {
		observer.close();
		await fs.promises.rm(temp.dir, { recursive: true, force: true });
	}
}
