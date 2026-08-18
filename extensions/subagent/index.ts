import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";

const MAX_HANDOFF_BYTES = 12 * 1024;
const MAX_TASK_BYTES = 4 * 1024;
const MAX_RECENT_RUNS = 20;
const ENTRY_TYPE = "pi-core-agent-run";
const STATUS_ID = "pi-core-background-agents";
const HANDOFF_INSTRUCTION =
	"Return only a concise final handoff: findings, exact file references, and actionable conclusions. Omit narration, tool transcripts, and repeated task text.";

const BackgroundAgentParams = Type.Object({
	agent: Type.String({ description: "scout, planner, reviewer, worker, or a user agent" }),
	task: Type.String({ description: "Independent task to run" }),
	cwd: Type.Optional(Type.String({ description: "Child working directory; defaults to the parent CWD" })),
});

const AgentControlParams = Type.Object({
	action: Type.Union([Type.Literal("status"), Type.Literal("message"), Type.Literal("stop")]),
	id: Type.Optional(Type.String({ description: "Run ID; omit for status of all runs" })),
	message: Type.Optional(Type.String({ description: "Steering message for action=message" })),
});

type RunStatus = "running" | "complete" | "failed" | "stopped";
type DeliveryStatus = "none" | "pending" | "delivered";

interface ChildHandle {
	abort(): void;
	message(text: string): void;
}

export interface ManagedRun {
	id: string;
	agent: string;
	task: string;
	cwd: string;
	status: RunStatus;
	delivery: DeliveryStatus;
	startedAt: number;
	finishedAt?: number;
	output?: string;
	error?: string;
	child?: ChildHandle;
	deliveryQueued?: boolean;
	generation: number;
}

export interface PersistedRun extends Partial<Omit<ManagedRun, "child" | "deliveryQueued" | "generation">> {
	id: string;
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

function newRunId(): string {
	return randomBytes(4).toString("hex");
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

function writeRpc(child: ChildProcessWithoutNullStreams, command: Record<string, unknown>): void {
	if (!child.stdin.writable) throw new Error("agent input is closed");
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

async function runAgent(
	agent: AgentConfig,
	task: string,
	ctx: ExtensionContext,
	cwd: string,
	onSpawn: (handle: ChildHandle) => void,
): Promise<string> {
	const args = ["--mode", "rpc", "--no-session"];
	const model = agent.model ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	if (model) args.push("--model", model);
	if (!agent.model && ctx.thinkingLevel) args.push("--thinking", ctx.thinkingLevel);
	if (agent.tools?.length) args.push("--tools", agent.tools.join(","));

	const temp = await writeSystemPrompt(agent);
	args.push("--append-system-prompt", temp.file);

	try {
		return await new Promise<string>((resolve, reject) => {
			const invocation = getPiInvocation(args);
			const child = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
			});
			let stderr = "";
			let buffer = "";
			let finalOutput = "";
			let settled = false;
			let aborted = false;

			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				child.kill("SIGTERM");
				if (error) reject(error);
				else resolve(finalOutput || "No final assistant output returned.");
			};

			const processLine = (line: string) => {
				if (!line.trim()) return;
				let event: { type?: unknown; message?: unknown };
				try {
					event = JSON.parse(line) as { type?: unknown; message?: unknown };
				} catch {
					return;
				}
				if (event.type === "message_end" && typeof event.message === "object" && event.message !== null) {
					const message = event.message as { role?: unknown; content?: unknown };
					if (message.role === "assistant" && Array.isArray(message.content)) {
						const blocks = message.content.flatMap((part) => {
							if (typeof part !== "object" || part === null) return [];
							const block = part as { type?: unknown; text?: unknown };
							return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
						});
						if (blocks.length > 0) finalOutput = blocks.join("\n\n");
					}
				}
				if (event.type === "agent_settled") finish(aborted ? new Error("stopped") : undefined);
			};

			onSpawn({
				abort() {
					aborted = true;
					try {
						writeRpc(child, { type: "abort" });
					} finally {
						setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
					}
				},
				message(text: string) {
					writeRpc(child, { type: "steer", message: text });
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
			child.on("error", (error) => finish(error));
			child.on("close", (code) => {
				if (buffer) processLine(buffer);
				if (settled) return;
				if (aborted) return finish(new Error("stopped"));
				finish(new Error(stderr.trim() || `agent exited ${code ?? "unknown"}`));
			});

			writeRpc(child, { type: "prompt", message: `Task: ${task}` });
		});
	} finally {
		await fs.promises.rm(temp.dir, { recursive: true, force: true });
	}
}

export function ownsRun(runs: ReadonlyMap<string, ManagedRun>, run: ManagedRun, generation: number): boolean {
	return runs.get(run.id) === run && run.generation === generation;
}

export function snapshotRun(run: ManagedRun, transition = false): PersistedRun {
	if (transition && run.delivery === "delivered") {
		return {
			id: run.id,
			status: run.status,
			delivery: run.delivery,
			finishedAt: run.finishedAt,
		};
	}
	return {
		id: run.id,
		agent: run.agent,
		task: truncateUtf8(run.task, MAX_TASK_BYTES),
		cwd: run.cwd,
		status: run.status,
		delivery: run.delivery,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		output: run.output ? truncateUtf8(run.output) : undefined,
		error: run.error ? truncateUtf8(run.error) : undefined,
	};
}

function completionText(run: ManagedRun): string {
	const body = run.status === "complete" ? run.output : run.error;
	return truncateUtf8(`agent: ${run.agent}\nid: ${run.id}\nstatus: ${run.status}\n\n${body || "No output."}`);
}

function compactStatus(run: ManagedRun): string {
	const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1_000));
	return `${run.id} ${run.agent} ${run.status} ${seconds}s`;
}

export default function backgroundAgents(pi: ExtensionAPI): void {
	const runs = new Map<string, ManagedRun>();
	let currentCtx: ExtensionContext | undefined;
	let branchGeneration = 0;

	const runningCount = () => [...runs.values()].filter((run) => run.status === "running").length;
	const updateStatus = () => {
		if (!currentCtx) return;
		const count = runningCount();
		try {
			currentCtx.ui.setStatus(STATUS_ID, count > 0 ? `⚙ ${count} agent${count === 1 ? "" : "s"}` : undefined);
		} catch {
			// Session replacement can invalidate the old UI context.
		}
	};
	const persist = (run: ManagedRun, transition = false) => {
		try {
			pi.appendEntry(ENTRY_TYPE, snapshotRun(run, transition));
			return true;
		} catch {
			currentCtx?.ui.notify(`Could not persist agent ${run.id} state.`, "warning");
			return false;
		}
	};
	const prune = () => {
		const completed = [...runs.values()]
			.filter((run) => run.status !== "running")
			.sort((a, b) => b.startedAt - a.startedAt);
		for (const run of completed.slice(MAX_RECENT_RUNS)) runs.delete(run.id);
	};
	const completionPresent = (run: ManagedRun) =>
		currentCtx?.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== "pi-core-background-agent-result")
				return false;
			const details = entry.details as { id?: unknown } | undefined;
			return details?.id === run.id;
		}) ?? false;
	const acknowledgeDelivery = (run: ManagedRun) => {
		if (!completionPresent(run)) return false;
		run.delivery = "delivered";
		run.deliveryQueued = false;
		persist(run, true);
		return true;
	};
	const deliver = (run: ManagedRun) => {
		if (run.delivery === "delivered" || run.status === "running" || run.deliveryQueued) return;
		if (acknowledgeDelivery(run)) return;
		try {
			pi.sendMessage(
				{
					customType: "pi-core-background-agent-result",
					content: completionText(run),
					display: true,
					details: { id: run.id },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			run.deliveryQueued = true;
		} catch {
			run.delivery = "pending";
			run.deliveryQueued = false;
			currentCtx?.ui.notify(`Agent ${run.id} finished; delivery pending and will retry.`, "warning");
		}
	};
	const finish = (run: ManagedRun, status: RunStatus, body: string) => {
		run.status = status;
		run.finishedAt = Date.now();
		run.child = undefined;
		run.delivery = "pending";
		run.deliveryQueued = false;
		if (status === "complete") run.output = truncateUtf8(body);
		else run.error = truncateUtf8(body);
		persist(run);
		updateStatus();
		deliver(run);
		prune();
	};
	const restoreActiveBranch = (ctx: ExtensionContext, interruptedReason: string) => {
		branchGeneration++;
		for (const run of runs.values()) run.child?.abort();
		runs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const patch = entry.data as PersistedRun;
			if (!patch?.id) continue;
			const prior = runs.get(patch.id);
			if (prior) Object.assign(prior, patch);
			else if (
				patch.agent &&
				patch.task !== undefined &&
				patch.cwd &&
				patch.status &&
				patch.delivery &&
				patch.startedAt
			) {
				runs.set(patch.id, { ...patch, generation: branchGeneration } as ManagedRun);
			}
		}
		for (const run of runs.values()) {
			if (run.status === "running") {
				run.status = "failed";
				run.error = interruptedReason;
				run.finishedAt = Date.now();
				run.delivery = "pending";
				persist(run);
			}
			if (run.delivery === "pending") deliver(run);
		}
		prune();
		updateStatus();
	};

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		restoreActiveBranch(ctx, "Parent session restarted before completion.");
	});

	pi.on("session_tree", (_event, ctx) => {
		currentCtx = ctx;
		restoreActiveBranch(ctx, "Parent changed session branch before completion.");
	});

	pi.on("agent_settled", () => {
		for (const run of runs.values()) {
			if (run.delivery !== "pending") continue;
			if (acknowledgeDelivery(run)) continue;
			run.deliveryQueued = false;
			deliver(run);
		}
	});

	pi.on("session_shutdown", () => {
		for (const run of runs.values()) run.child?.abort();
		currentCtx = undefined;
	});

	pi.registerTool({
		name: "background_agent",
		label: "Background Agent",
		description:
			"Run independent work asynchronously. Returns a short ID; completion is pushed automatically and durably. Never poll unless asked. Bundled: scout, planner, reviewer, worker.",
		parameters: BackgroundAgentParams,
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const agents = discoverAgents(ctx.cwd, "user").agents;
			const agent = agents.find((candidate) => candidate.name === params.agent);
			if (!agent)
				throw new Error(`Unknown agent. Available: ${agents.map((item) => item.name).join(", ") || "none"}.`);

			const cwd = path.resolve(ctx.cwd, params.cwd ?? ctx.cwd);
			if (!fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory())
				throw new Error(`Invalid child CWD: ${cwd}`);

			let id = newRunId();
			while (runs.has(id)) id = newRunId();
			const run: ManagedRun = {
				id,
				agent: agent.name,
				task: truncateUtf8(params.task, MAX_TASK_BYTES),
				cwd,
				status: "running",
				delivery: "none",
				startedAt: Date.now(),
				generation: branchGeneration,
			};
			runs.set(id, run);
			persist(run);

			void runAgent(agent, params.task, ctx, cwd, (child) => {
				if (!ownsRun(runs, run, branchGeneration)) {
					child.abort();
					return;
				}
				run.child = child;
				updateStatus();
			})
				.then((output) => {
					if (ownsRun(runs, run, branchGeneration)) finish(run, "complete", output);
				})
				.catch((error: unknown) => {
					if (!ownsRun(runs, run, branchGeneration)) return;
					const message = error instanceof Error ? error.message : String(error);
					finish(run, message === "stopped" ? "stopped" : "failed", message);
				});

			return { content: [{ type: "text", text: `started ${agent.name} ${id}` }], details: { id } };
		},
	});

	pi.registerTool({
		name: "agent_control",
		label: "Agent Control",
		description: "Get compact run status, steer a running agent, or stop it.",
		parameters: AgentControlParams,
		async execute(_toolCallId, params) {
			if (params.action === "status") {
				if (params.id) {
					const run = runs.get(params.id);
					if (!run) throw new Error(`Unknown run: ${params.id}`);
					const result =
						run.status === "running"
							? compactStatus(run)
							: `${compactStatus(run)}\n${run.output ?? run.error ?? ""}`;
					return { content: [{ type: "text", text: truncateUtf8(result) }], details: {} };
				}
				const recent = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECENT_RUNS);
				return {
					content: [{ type: "text", text: recent.length ? recent.map(compactStatus).join("\n") : "0 runs" }],
					details: {},
				};
			}

			if (!params.id) throw new Error(`action=${params.action} requires id`);
			const run = runs.get(params.id);
			if (!run) throw new Error(`Unknown run: ${params.id}`);
			if (run.status !== "running" || !run.child) throw new Error(`Run ${params.id} is ${run.status}`);
			if (params.action === "message") {
				if (!params.message?.trim()) throw new Error("action=message requires message");
				run.child.message(params.message);
				return { content: [{ type: "text", text: `sent ${params.id}` }], details: {} };
			}
			run.child.abort();
			return { content: [{ type: "text", text: `stopping ${params.id}` }], details: {} };
		},
	});
}
