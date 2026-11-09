import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { type ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";
import type { AgentConfig } from "./agents.ts";
import {
	createSidecarChannel,
	isReady,
	openSidecarChannel,
	readExit,
	readQuestion,
	readResult,
	removeSidecar,
	type SidecarChannel,
	waitForCommand,
	watchSidecar,
	writeCommand,
} from "./channel.ts";
import { HerdrClient, type HerdrLocation } from "./herdr.ts";
import type { SubagentLimits } from "./limits.ts";
import { truncateUtf8 } from "./limits.ts";
import { type ChildLineage, encodeChildLineage, type PendingQuestion, RpcEventTracker } from "./protocol.ts";
import { createTmuxClient, type TmuxClient, TmuxLaunchError } from "./tmux.ts";

const HANDOFF_INSTRUCTION =
	"Return a concise result of the assigned task in a form the parent can act on. Include evidence and references where they support the result, and identify decisions or unresolved blockers that need attention. Adapt the format to the task; omit repeated instructions and tool transcripts.";
const SIDECAR_CLEANUP_DELAY_MS = 15_000;

export const SUBAGENT_EXTENSION_PATH = path.join(import.meta.dirname, "index.ts");
/** These add no tools, so children keep their allowlist while sharing speed and context behavior. */
export const CHILD_EXTENSION_PATHS = ["fast-mode", "json-headroom", "nested-agents"].map((name) =>
	path.join(import.meta.dirname, "..", name, "index.ts"),
);

interface TuiRuntimeFields {
	sessionFile: string;
	paneId: string;
	channelDirectory: string;
	channelToken: string;
}

export type InteractiveRuntime = TuiRuntimeFields &
	({ backend: "tmux-tui" } | { backend: "herdr-tui"; location: HerdrLocation });

export type ChildRuntime = { backend: "rpc"; sessionFile: string } | InteractiveRuntime;

export interface ChildHandle {
	runtime: ChildRuntime;
	abort(): void;
	message(text: string): void;
	reply(questionId: string, text: string): void | Promise<void>;
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

export function parentPromptCommand(text: string): Record<string, unknown> {
	// Let the child's SDK decide whether to start or steer; lifecycle events can already be stale.
	return {
		type: "prompt",
		message: text,
		streamingBehavior: "steer",
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
	return `${prompt.trim()}\n\n${HANDOFF_INSTRUCTION}\nResolve routine decisions using the task context and your judgment. Use ask_parent when missing information or authority materially blocks progress; continue independent work when possible.${delegation}\n`;
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
	tools.add("codemode");
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
		...CHILD_EXTENSION_PATHS.flatMap((extension) => ["--extension", extension]),
		"--headroom-json",
		"--nested-agents",
		"--no-skills",
		"--no-prompt-templates",
		"--no-approve",
	);
	const parentModel = options.ctx.model ? `${options.ctx.model.provider}/${options.ctx.model.id}` : undefined;
	const model = options.model ?? options.agent.model ?? parentModel;
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
					env: {
						...process.env,
						PI_CORE_SUBAGENT_CONTEXT: encodeChildLineage(options.lineage),
					},
					shell: false,
					stdio: ["pipe", "pipe", "pipe"],
				});
				const tracker = new RpcEventTracker(options.limits.questionBytes);
				const decoder = new StringDecoder("utf8");
				let stderr = "";
				let buffer = "";
				let settled = false;
				let aborted = false;
				let forceKill: NodeJS.Timeout | undefined;
				const replies = new Map<
					string,
					{
						questionId: string;
						text: string;
						resolve(): void;
						reject(error: Error): void;
						timer: NodeJS.Timeout;
					}
				>();
				const acceptedReplies = new Map<string, string>();

				const finish = (error?: Error, output?: string) => {
					if (settled) return;
					settled = true;
					if (forceKill) clearTimeout(forceKill);
					for (const reply of replies.values()) {
						clearTimeout(reply.timer);
						reply.reject(error ?? new Error("Child ended before accepting the reply."));
					}
					replies.clear();
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
							"id" in raw &&
							typeof raw.id === "string" &&
							"type" in raw &&
							raw.type === "response"
						) {
							const reply = replies.get(raw.id);
							if (reply && "success" in raw && raw.success === true) {
								tracker.acceptReply(reply.questionId);
								acceptedReplies.set(reply.questionId, reply.text);
								clearTimeout(reply.timer);
								replies.delete(raw.id);
								options.onStatus("running");
								reply.resolve();
							}
						}
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
						writeRpc(child, parentPromptCommand(text));
					},
					reply(questionId: string, text: string) {
						return new Promise<void>((resolve, reject) => {
							const id = `reply-${questionId}`;
							if (acceptedReplies.has(questionId)) {
								if (acceptedReplies.get(questionId) !== text)
									return reject(new Error("A different reply was already accepted."));
								return resolve();
							}
							if (replies.has(id))
								return reject(new Error("Reply is already awaiting acceptance; no duplicate was submitted."));
							const timer = setTimeout(() => {
								// Keep correlation for a late response; timeout is not proof of rejection.
								reject(
									new Error("Child RPC reply acceptance timed out; inspect child status before retrying."),
								);
							}, 15_000);
							replies.set(id, { questionId, text, resolve, reject, timer });
							try {
								writeRpc(child, {
									...parentPromptCommand(
										`Parent reply: ${text}\n\nContinue the assigned task using this answer.`,
									),
									id,
								});
							} catch (error) {
								clearTimeout(timer);
								replies.delete(id);
								reject(error);
							}
						});
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

class InteractiveRunner {
	constructor(
		private readonly tmux: TmuxClient,
		private readonly runRoot?: string,
		private readonly sessionDir?: string,
		private readonly herdr?: HerdrClient,
	) {}

	available(): boolean {
		return this.herdr ? this.herdr.available() : this.tmux.available();
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
		let location: HerdrLocation | undefined;
		try {
			const launch = {
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
			};
			if (this.herdr) {
				location = await this.herdr.launch(
					launch,
					options.ctx.sessionManager.getSessionFile() ?? options.cwd,
				);
				paneId = location.paneId;
			} else paneId = this.tmux.launch(launch);
		} catch (error) {
			// Herdr may have admitted a launch even when its response was lost.
			if (this.herdr) throw error;
			removeSidecar(channel);
			fs.rmSync(sessionFile, { force: true });
			throw error instanceof TmuxLaunchError
				? error
				: new TmuxLaunchError("Could not launch tmux child.", { cause: error });
		}
		return this.supervise(options, channel, {
			...(location ? { backend: "herdr-tui" as const, location } : { backend: "tmux-tui" as const }),
			sessionFile,
			paneId,
			channelDirectory: channel.directory,
			channelToken: channel.token,
		});
	}

	async attach(options: RunAgentOptions, runtime: InteractiveRuntime): Promise<string> {
		if (runtime.backend === "herdr-tui")
			this.herdr?.remember(options.ctx.sessionManager.getSessionFile() ?? options.cwd, runtime.location);
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
		runtime: InteractiveRuntime,
	): Promise<string> {
		return new Promise<string>((resolve, reject) => {
			let terminal = false;
			let detached = false;
			let lastQuestionId: string | undefined;
			const startupDeadline = Date.now() + 30_000;
			let forceKill: NodeJS.Timeout | undefined;
			let livenessTimer: NodeJS.Timeout | undefined;
			let checkingPane = false;
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
				if (!error || runtime.backend !== "herdr-tui") {
					setTimeout(() => removeSidecar(channel), SIDECAR_CLEANUP_DELAY_MS).unref();
				}
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
					else if (runtime.backend === "herdr-tui" && Date.now() >= startupDeadline && !isReady(channel)) {
						writeCommand(channel, { type: "cancel" });
						finish(
							new Error("Herdr child did not acknowledge startup within 30 seconds; cancellation queued."),
						);
					}
				} catch (error) {
					finish(error instanceof Error ? error : new Error(String(error)));
				}
			};

			stopWatching = watchSidecar(channel, scan);
			livenessTimer = setInterval(() => {
				if (terminal || detached) return;
				// Notifications are hints: reconcile durable state even if fs.watch misses an event.
				scan();
				if (terminal || checkingPane) return;
				checkingPane = true;
				void (async () => {
					try {
						const alive =
							runtime.backend === "herdr-tui"
								? await this.herdr?.alive(runtime.location)
								: this.tmux.alive(runtime.paneId);
						if (!terminal && !detached && alive === false) {
							scan();
							// Herdr pane moves change public IDs. A fresh private heartbeat
							// proves this child still lives independently of its visual location.
							if (!terminal && (runtime.backend !== "herdr-tui" || !isReady(channel, 5_000))) {
								finish(new Error("interactive child pane closed before completion"));
							}
						}
					} finally {
						checkingPane = false;
					}
				})();
			}, 1_000);
			livenessTimer.unref();
			options.onSpawn({
				runtime,
				abort: () => {
					if (terminal || detached) return;
					writeCommand(channel, { type: "cancel" });
					forceKill = setTimeout(() => {
						if (runtime.backend === "herdr-tui") {
							finish(new Error("Herdr cancellation unconfirmed; inspect the retained child terminal."));
						} else {
							this.tmux.kill(runtime.paneId);
							finish(new Error("stopped"));
						}
					}, 2_000);
					forceKill.unref();
				},
				message: (text) => writeCommand(channel, { type: "message", text }),
				reply: async (questionId, text) => {
					const id = writeCommand(channel, { type: "reply", questionId, text });
					await waitForCommand(channel, id);
					options.onStatus("running");
				},
				detach: () => {
					if (terminal || detached) return;
					detached = true;
					close();
					reject(new RunnerDetachedError());
				},
			});
			options.onStatus(runtime.backend === "herdr-tui" ? "running in Herdr tab" : "running in tmux pane");
			scan();
		});
	}
}

interface RpcBackend {
	run(options: RunAgentOptions): Promise<string>;
}

interface TmuxBackend extends RpcBackend {
	available(): boolean;
	attach(options: RunAgentOptions, runtime: InteractiveRuntime): Promise<string>;
}

export function createTmuxTuiRunner(
	tmux: TmuxClient = createTmuxClient(),
	runRoot?: string,
	sessionDir?: string,
): TmuxBackend {
	return new InteractiveRunner(tmux, runRoot, sessionDir);
}

export function createHerdrTuiRunner(
	herdr: HerdrClient = new HerdrClient(),
	runRoot?: string,
	sessionDir?: string,
): TmuxBackend {
	return new InteractiveRunner(createTmuxClient(), runRoot, sessionDir, herdr);
}

export class RunnerRouter {
	constructor(
		private readonly rpc: RpcBackend = new RpcRunner(),
		private readonly tmux: TmuxBackend = createTmuxTuiRunner(),
		private readonly herdr: TmuxBackend = createHerdrTuiRunner(),
	) {}

	async run(options: RunAgentOptions): Promise<string> {
		// Never target an outer tmux session when this process belongs to Herdr.
		if (this.herdr.available()) return this.herdr.run(options);
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
		if (runtime.backend === "rpc") {
			return Promise.reject(new Error("RPC children cannot be reattached after reload."));
		}
		return (runtime.backend === "herdr-tui" ? this.herdr : this.tmux).attach(options, runtime);
	}
}

const defaultRouter = new RunnerRouter();

export function runAgent(options: RunAgentOptions): Promise<string> {
	return defaultRouter.run(options);
}

export function attachAgent(options: RunAgentOptions, runtime: ChildRuntime): Promise<string> {
	return defaultRouter.attach(options, runtime);
}
