import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import {
	createSidecarChannel,
	openSidecarChannel,
	readExit,
	readQuestion,
	readResult,
	removeSidecar,
	type SidecarChannel,
	watchSidecar,
	writeCommand,
} from "./channel.ts";
import type { SubagentLimits } from "./limits.ts";
import { truncateUtf8 } from "./limits.ts";
import { type ChildLineage, encodeChildLineage, type PendingQuestion, RpcEventTracker } from "./protocol.ts";
import { createTmuxClient, type TmuxClient, TmuxLaunchError } from "./tmux.ts";

const HANDOFF_INSTRUCTION =
	"Return only a concise final handoff: findings, exact file references, and actionable conclusions. Omit narration, tool transcripts, thinking, and repeated task text.";
const SIDECAR_CLEANUP_DELAY_MS = 15_000;

export const SUBAGENT_EXTENSION_PATH = path.join(import.meta.dirname, "index.ts");
export const CONTEXT_GUARD_EXTENSION_PATH = path.join(import.meta.dirname, "..", "context-guard", "index.ts");

export type ChildRuntime =
	| { backend: "rpc"; sessionFile: string }
	| {
			backend: "tmux-tui";
			sessionFile: string;
			paneId: string;
			channelDirectory: string;
			channelToken: string;
	  };

export interface ChildHandle {
	runtime: ChildRuntime;
	abort(): void;
	message(text: string): void;
	reply(questionId: string, text: string): void;
	detach(): void;
}

export interface RunAgentOptions {
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

export class RunnerDetachedError extends Error {
	constructor() {
		super("runner detached for reload");
		this.name = "RunnerDetachedError";
	}
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

function systemPrompt(agent: AgentConfig): string {
	const prompt = agent.systemPrompt.replaceAll(
		"{{REVIEW_SKILL_DIR}}",
		path.join(import.meta.dirname, "reviewer-skill"),
	);
	const delegation = agent.children?.length
		? `\nYou may delegate only to these named child agents: ${agent.children.join(", ")}.`
		: "";
	return `${prompt.trim()}\n\n${HANDOFF_INSTRUCTION}\nUse ask_parent for one blocking question instead of guessing.${delegation}\n`;
}

async function writeLaunchFiles(
	directory: string,
	agent: AgentConfig,
	task: string,
): Promise<{ system: string; task: string }> {
	const system = path.join(directory, "system.md");
	const taskFile = path.join(directory, "task.md");
	await Promise.all([
		fs.promises.writeFile(system, systemPrompt(agent), { encoding: "utf8", mode: 0o600 }),
		fs.promises.writeFile(taskFile, `Task: ${task}\n`, { encoding: "utf8", mode: 0o600 }),
	]);
	return { system, task: taskFile };
}

function createChildSession(options: RunAgentOptions, sessionDir?: string): string {
	const session = SessionManager.create(options.cwd, sessionDir, {
		parentSession: options.ctx.sessionManager.getSessionFile(),
	});
	session.appendSessionInfo(`agent:${options.agent.name}:${options.lineage.runId}`);
	session.appendCustomEntry("pi-core-subagent-lineage", {
		protocol: "pi-core.child-lineage.v1",
		...options.lineage,
	});
	const file = session.getSessionFile();
	const header = session.getHeader();
	if (!file || !header) throw new Error("Could not create a persistent child session.");
	const records = [header, ...session.getEntries()].map((entry) => JSON.stringify(entry)).join("\n");
	fs.writeFileSync(file, `${records}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
	return file;
}

function writeRpc(child: ChildProcessWithoutNullStreams, command: Record<string, unknown>): void {
	if (!child.stdin.writable) throw new Error("agent input is closed");
	child.stdin.write(`${JSON.stringify(command)}\n`);
}

export function buildChildTools(agent: AgentConfig, lineage: ChildLineage): string[] {
	const tools = new Set(agent.tools ?? []);
	tools.add("ask_parent");
	if (lineage.allowedChildren.length > 0 && lineage.depth < lineage.limits.maxDepth) {
		tools.add("background_agent");
		tools.add("agent_control");
	}
	return [...tools];
}

export function buildChildArgs(
	options: Pick<RunAgentOptions, "agent" | "ctx" | "lineage" | "model" | "thinking">,
	systemPromptFile: string,
	extensionPath = SUBAGENT_EXTENSION_PATH,
	launch: { mode?: "rpc" | "tui"; sessionFile?: string; name?: string } = {},
): string[] {
	const args = launch.mode === "tui" ? [] : ["--mode", "rpc"];
	if (launch.sessionFile) args.push("--session", path.resolve(launch.sessionFile));
	else args.push("--no-session");
	args.push(
		"--no-extensions",
		"--extension",
		path.resolve(extensionPath),
		"--extension",
		path.resolve(CONTEXT_GUARD_EXTENSION_PATH),
		"--no-skills",
		"--no-prompt-templates",
		"--no-approve",
	);
	const model =
		options.model ??
		options.agent.model ??
		(options.ctx.model ? `${options.ctx.model.provider}/${options.ctx.model.id}` : undefined);
	if (model) args.push("--model", model);
	const thinking = options.thinking ?? (!options.agent.model ? options.ctx.thinkingLevel : undefined);
	if (thinking) args.push("--thinking", thinking);
	args.push("--tools", buildChildTools(options.agent, options.lineage).join(","));
	args.push("--append-system-prompt", path.resolve(systemPromptFile));
	if (launch.name) args.push("--name", launch.name);
	return args;
}

class RpcRunner {
	async run(options: RunAgentOptions): Promise<string> {
		const temporary = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pi-background-agent-"));
		const files = await writeLaunchFiles(temporary, options.agent, options.task);
		const sessionFile = createChildSession(options);
		const args = buildChildArgs(options, files.system, SUBAGENT_EXTENSION_PATH, { mode: "rpc", sessionFile });
		try {
			return await new Promise<string>((resolve, reject) => {
				const invocation = getPiInvocation(args);
				const child = spawn(invocation.command, invocation.args, {
					cwd: options.cwd,
					env: { ...process.env, PI_CORE_SUBAGENT_CONTEXT: encodeChildLineage(options.lineage) },
					shell: false,
					stdio: ["pipe", "pipe", "pipe"],
				});
				const tracker = new RpcEventTracker(options.limits.questionBytes);
				const decoder = new StringDecoder("utf8");
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
						} else if (event.type === "nested_started") {
							options.onStatus("waiting for delegated work");
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

				const runtime: ChildRuntime = { backend: "rpc", sessionFile };
				options.onSpawn({
					runtime,
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
					},
					detach() {
						this.abort();
					},
				});

				child.stdout.on("data", (chunk: Buffer) => {
					buffer += decoder.write(chunk);
					while (true) {
						const newline = buffer.indexOf("\n");
						if (newline === -1) break;
						let line = buffer.slice(0, newline);
						buffer = buffer.slice(newline + 1);
						if (line.endsWith("\r")) line = line.slice(0, -1);
						processLine(line);
					}
				});
				child.stderr.on("data", (chunk: Buffer) => {
					stderr = truncateUtf8(stderr + chunk.toString(), options.limits.handoffBytes);
				});
				child.on("error", (error) => finish(error));
				child.on("close", (code) => {
					buffer += decoder.end();
					if (buffer) processLine(buffer);
					if (settled) return;
					if (aborted) return finish(new Error("stopped"));
					finish(new Error(stderr.trim() || `agent exited ${code ?? "unknown"}`));
				});

				options.onStatus("running");
				if (!aborted) writeRpc(child, { type: "prompt", message: `Task: ${options.task}` });
			});
		} finally {
			await fs.promises.rm(temporary, { recursive: true, force: true });
		}
	}
}

class TmuxTuiRunner {
	constructor(
		private readonly tmux: TmuxClient = createTmuxClient(),
		private readonly runRoot?: string,
		private readonly sessionDir?: string,
	) {}

	available(): boolean {
		return this.tmux.available();
	}

	async run(options: RunAgentOptions): Promise<string> {
		const channel = createSidecarChannel({ runRoot: this.runRoot, lineage: options.lineage });
		const files = await writeLaunchFiles(channel.directory, options.agent, options.task);
		const sessionFile = createChildSession(options, this.sessionDir);
		const name = `agent:${options.agent.name}:${options.lineage.runId}`;
		const args = buildChildArgs(options, files.system, SUBAGENT_EXTENSION_PATH, {
			mode: "tui",
			sessionFile,
			name,
		});
		args.push(`@${files.task}`);
		const invocation = getPiInvocation(args);
		let paneId: string;
		try {
			paneId = this.tmux.launch({
				cwd: options.cwd,
				title: name,
				channelDirectory: channel.directory,
				channelToken: channel.token,
				environment: {
					PI_CORE_SUBAGENT_CONTEXT: encodeChildLineage(options.lineage),
					PI_CORE_SUBAGENT_CHANNEL: channel.directory,
					PI_CORE_SUBAGENT_CHANNEL_TOKEN: channel.token,
				},
				command: invocation.command,
				args: invocation.args,
			});
		} catch (error) {
			removeSidecar(channel);
			fs.rmSync(sessionFile, { force: true });
			throw error instanceof TmuxLaunchError
				? error
				: new TmuxLaunchError("Could not launch tmux child.", { cause: error });
		}
		return this.supervise(options, channel, {
			backend: "tmux-tui",
			sessionFile,
			paneId,
			channelDirectory: channel.directory,
			channelToken: channel.token,
		});
	}

	async attach(
		options: RunAgentOptions,
		runtime: Extract<ChildRuntime, { backend: "tmux-tui" }>,
	): Promise<string> {
		const channel = openSidecarChannel({
			directory: runtime.channelDirectory,
			token: runtime.channelToken,
			lineage: options.lineage,
		});
		return this.supervise(options, channel, runtime);
	}

	private async supervise(
		options: RunAgentOptions,
		channel: SidecarChannel,
		runtime: Extract<ChildRuntime, { backend: "tmux-tui" }>,
	): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let terminal = false;
			let detached = false;
			let lastQuestionId: string | undefined;
			let forceKill: NodeJS.Timeout | undefined;
			let livenessTimer: NodeJS.Timeout | undefined;
			let stopWatching = () => {};

			const close = () => {
				stopWatching();
				if (forceKill) clearTimeout(forceKill);
				if (livenessTimer) clearInterval(livenessTimer);
			};
			const finish = (error?: Error, output?: string) => {
				if (terminal || detached) return;
				terminal = true;
				close();
				setTimeout(() => removeSidecar(channel), SIDECAR_CLEANUP_DELAY_MS).unref();
				if (error) reject(error);
				else resolve(output || "No final assistant output returned.");
			};
			const scan = () => {
				if (terminal || detached) return;
				try {
					const result = readResult(channel);
					if (result) {
						if (result.status === "complete") finish(undefined, result.output);
						else finish(new Error(result.status === "stopped" ? "stopped" : result.output));
						return;
					}
					const question = readQuestion(channel);
					if (question && question.id !== lastQuestionId) {
						lastQuestionId = question.id;
						options.onQuestion({
							id: question.id,
							text: truncateUtf8(question.text, options.limits.questionBytes),
							askedAt: question.askedAt,
							delivered: false,
						});
						options.onStatus("waiting for parent reply");
					}
					const exit = readExit(channel);
					if (exit) finish(new Error(`interactive child pane exited ${exit.code}`));
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			};

			stopWatching = watchSidecar(channel, scan);
			livenessTimer = setInterval(() => {
				if (terminal || detached || this.tmux.alive(runtime.paneId)) return;
				scan();
				if (!terminal) finish(new Error("interactive child pane closed before completion"));
			}, 1_000);
			livenessTimer.unref();
			options.onSpawn({
				runtime,
				abort: () => {
					if (terminal || detached) return;
					writeCommand(channel, { type: "cancel" });
					forceKill = setTimeout(() => this.tmux.kill(runtime.paneId), 2_000);
					forceKill.unref();
				},
				message: (text) => writeCommand(channel, { type: "message", text }),
				reply: (questionId, text) => {
					writeCommand(channel, { type: "reply", questionId, text });
					options.onStatus("running");
				},
				detach: () => {
					if (terminal || detached) return;
					detached = true;
					close();
					reject(new RunnerDetachedError());
				},
			});
			options.onStatus("running in tmux pane");
			scan();
		});
	}
}

interface RpcBackend {
	run(options: RunAgentOptions): Promise<string>;
}

interface TmuxBackend extends RpcBackend {
	available(): boolean;
	attach(options: RunAgentOptions, runtime: Extract<ChildRuntime, { backend: "tmux-tui" }>): Promise<string>;
}

export function createTmuxTuiRunner(
	tmux: TmuxClient = createTmuxClient(),
	runRoot?: string,
	sessionDir?: string,
): TmuxBackend {
	return new TmuxTuiRunner(tmux, runRoot, sessionDir);
}

export class RunnerRouter {
	constructor(
		private readonly rpc: RpcBackend = new RpcRunner(),
		private readonly tmux: TmuxBackend = createTmuxTuiRunner(),
	) {}

	async run(options: RunAgentOptions): Promise<string> {
		if (this.tmux.available()) {
			try {
				return await this.tmux.run(options);
			} catch (error) {
				if (!(error instanceof TmuxLaunchError)) throw error;
				options.onStatus("tmux launch failed; using RPC");
			}
		}
		return this.rpc.run(options);
	}

	attach(options: RunAgentOptions, runtime: ChildRuntime): Promise<string> {
		if (runtime.backend !== "tmux-tui") {
			return Promise.reject(new Error("RPC children cannot be reattached after reload."));
		}
		return this.tmux.attach(options, runtime);
	}
}

const defaultRouter = new RunnerRouter();

export function runAgent(options: RunAgentOptions): Promise<string> {
	return defaultRouter.run(options);
}

export function attachAgent(options: RunAgentOptions, runtime: ChildRuntime): Promise<string> {
	return defaultRouter.attach(options, runtime);
}
