import { createHash, randomBytes } from "node:crypto";
import { existsSync, statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type ProcessLog, ProcessLogStore } from "./log-store.js";
import {
	boundedProcessTail,
	type ProcessHandle,
	type ProcessMode,
	type ProcessResult,
	type ProcessStatus,
	runBackgroundProcess,
	truncateProcessText,
} from "./process.js";

const ENTRY_TYPE = "pi-core-background-process-run";
const RESULT_TYPE = "pi-core-background-process-result";
const STATUS_ID = "pi-core-background-processes";
const MAX_COMMAND_BYTES = 4 * 1024;
const MAX_PUSH_BYTES = 4 * 1024;
const MAX_STATUS_BYTES = 12 * 1024;
const MAX_RECENT_RUNS = 20;
const MAX_CONCURRENT_RUNS = 8;

type DeliveryStatus = "none" | "pending" | "delivered";

export interface BackgroundProcessRun {
	id: string;
	command: string;
	cwd: string;
	mode: ProcessMode;
	timeoutSeconds?: number;
	status: ProcessStatus;
	delivery: DeliveryStatus;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	output?: string;
	logBytes: number;
	pid?: number;
	log?: ProcessLog;
	handle?: ProcessHandle;
	deliveryQueued?: boolean;
	generation: number;
}

export interface PersistedBackgroundProcessRun
	extends Partial<Omit<BackgroundProcessRun, "log" | "handle" | "deliveryQueued" | "generation">> {
	id: string;
}

const BackgroundProcessParams = Type.Object({
	command: Type.String({ maxLength: MAX_COMMAND_BYTES, description: "Shell command to run asynchronously" }),
	mode: Type.Union([Type.Literal("wait"), Type.Literal("service")], {
		description: "wait expects a terminal result; service is expected to remain running",
	}),
	cwd: Type.Optional(
		Type.String({ maxLength: 4096, description: "Working directory; defaults to the parent CWD" }),
	),
	timeoutSeconds: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 86_400,
			description: "Optional safety deadline in seconds",
		}),
	),
});

const ProcessControlParams = Type.Object({
	action: Type.Union([Type.Literal("status"), Type.Literal("search"), Type.Literal("stop")]),
	id: Type.Optional(
		Type.String({ minLength: 8, maxLength: 8, pattern: "^[a-f0-9]{8}$", description: "Process ID" }),
	),
	query: Type.Optional(
		Type.String({
			minLength: 2,
			maxLength: 256,
			description: "Terms that must occur on a matching log line",
		}),
	),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Maximum matching log lines" })),
});

function newId(): string {
	return randomBytes(4).toString("hex");
}

function sessionLogDirectory(sessionId: string): string {
	const directory = createHash("sha256").update(sessionId).digest("hex").slice(0, 16);
	return join(getAgentDir(), "pi-core", "processes", directory);
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function elapsedSeconds(run: BackgroundProcessRun): number {
	return Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1_000));
}

function commandSummary(command: string, maxCharacters = 160): string {
	const line = command.replace(/\s+/gu, " ").trim();
	return line.length <= maxCharacters ? line : `${line.slice(0, maxCharacters - 1)}…`;
}

export function compactProcessStatus(run: BackgroundProcessRun): string {
	const pid = run.pid ? ` pid=${run.pid}` : "";
	const logBytes = run.log?.retainedBytes() ?? run.logBytes;
	return `${run.id} ${run.mode} ${run.status} ${elapsedSeconds(run)}s ${basename(run.cwd)} ${formatBytes(logBytes)}${pid}`;
}

export function detailedProcessStatus(run: BackgroundProcessRun, includeTail = true): string {
	const header = `${compactProcessStatus(run)}\ncwd: ${run.cwd}\ncommand: ${commandSummary(run.command)}`;
	const tail = includeTail ? run.log?.tail(MAX_PUSH_BYTES) : "";
	return tail ? `${header}\n\nrecent log:\n${tail}` : header;
}

export function ownsProcess(
	runs: ReadonlyMap<string, BackgroundProcessRun>,
	run: BackgroundProcessRun,
	generation: number,
): boolean {
	return runs.get(run.id) === run && run.generation === generation;
}

export function snapshotProcess(
	run: BackgroundProcessRun,
	transition = false,
): PersistedBackgroundProcessRun {
	if (transition && run.delivery === "delivered") {
		return {
			id: run.id,
			status: run.status,
			delivery: run.delivery,
			finishedAt: run.finishedAt,
			exitCode: run.exitCode,
		};
	}
	return {
		id: run.id,
		command: truncateProcessText(run.command, MAX_COMMAND_BYTES),
		cwd: run.cwd,
		mode: run.mode,
		timeoutSeconds: run.timeoutSeconds,
		status: run.status,
		delivery: run.delivery,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		exitCode: run.exitCode,
		output: run.output ? boundedProcessTail(run.output) : undefined,
		logBytes: run.logBytes,
		pid: run.pid,
	};
}

export function processCompletionText(run: BackgroundProcessRun, maxBytes = MAX_PUSH_BYTES): string {
	const header = `process: ${run.id}\nmode: ${run.mode}\nstatus: ${run.status}\nexit: ${run.exitCode ?? "none"}\n\n`;
	const bodyBudget = Math.max(0, maxBytes - Buffer.byteLength(header));
	const body = run.output || "No output.";
	const bytes = Buffer.from(body);
	if (bytes.length <= bodyBudget) return `${header}${body}`;

	const marker = "[truncated: showing output tail; use process_control search for exact log evidence]\n";
	const tailBudget = Math.max(0, bodyBudget - Buffer.byteLength(marker));
	const start = Math.max(0, bytes.length - tailBudget);
	let tail = bytes.subarray(start).toString("utf8").replace(/^�/u, "");
	if (start > 0) {
		const newline = tail.indexOf("\n");
		tail = newline >= 0 ? tail.slice(newline + 1) : "";
	}
	return `${header}${marker}${tail}`;
}

export default function backgroundProcess(pi: ExtensionAPI): void {
	const runs = new Map<string, BackgroundProcessRun>();
	let logStore: ProcessLogStore | undefined;
	let currentCtx: ExtensionContext | undefined;
	let branchGeneration = 0;

	const updateStatus = () => {
		if (!currentCtx) return;
		const count = [...runs.values()].filter((run) => run.status === "running").length;
		try {
			currentCtx.ui.setStatus(STATUS_ID, count ? `◉ ${count} process${count === 1 ? "" : "es"}` : undefined);
		} catch {
			// Session replacement can invalidate the old UI context.
		}
	};
	const persist = (run: BackgroundProcessRun, transition = false) => {
		try {
			pi.appendEntry(ENTRY_TYPE, snapshotProcess(run, transition));
			return true;
		} catch {
			currentCtx?.ui.notify(`Could not persist process ${run.id} state.`, "warning");
			return false;
		}
	};
	const prune = () => {
		const finished = [...runs.values()]
			.filter((run) => run.status !== "running")
			.sort((a, b) => b.startedAt - a.startedAt);
		for (const run of finished.slice(MAX_RECENT_RUNS)) {
			runs.delete(run.id);
			run.log?.remove();
			logStore?.remove(run.id);
		}
	};
	const completionPresent = (run: BackgroundProcessRun) =>
		currentCtx?.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== RESULT_TYPE) return false;
			return (entry.details as { id?: unknown } | undefined)?.id === run.id;
		}) ?? false;
	const acknowledge = (run: BackgroundProcessRun) => {
		if (!completionPresent(run)) return false;
		run.delivery = "delivered";
		run.deliveryQueued = false;
		persist(run, true);
		return true;
	};
	const deliver = (run: BackgroundProcessRun) => {
		if (run.status === "running" || run.delivery === "delivered" || run.deliveryQueued) return;
		if (acknowledge(run)) return;
		try {
			pi.sendMessage(
				{
					customType: RESULT_TYPE,
					content: processCompletionText(run),
					display: true,
					details: { id: run.id },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			run.deliveryQueued = true;
		} catch {
			run.delivery = "pending";
			run.deliveryQueued = false;
			currentCtx?.ui.notify(`Process ${run.id} finished; delivery will retry.`, "warning");
		}
	};
	const finish = (run: BackgroundProcessRun, result: ProcessResult) => {
		run.status = result.status;
		run.exitCode = result.exitCode;
		run.output = boundedProcessTail(result.output);
		run.logBytes = result.logBytes;
		run.finishedAt = Date.now();
		run.handle = undefined;
		run.delivery = "pending";
		run.deliveryQueued = false;
		persist(run);
		updateStatus();
		deliver(run);
		prune();
	};
	const fail = (run: BackgroundProcessRun, error: unknown) =>
		finish(run, {
			status: "failed",
			exitCode: null,
			output: error instanceof Error ? error.message : String(error),
			logBytes: run.log?.retainedBytes() ?? run.logBytes,
		});
	const stop = (run: BackgroundProcessRun): boolean => {
		if (run.status !== "running" || !run.handle) return false;
		run.handle.stop();
		return true;
	};
	const restore = (ctx: ExtensionContext, reason: string) => {
		branchGeneration++;
		for (const run of runs.values()) run.handle?.stop();
		runs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const patch = entry.data as PersistedBackgroundProcessRun;
			if (!patch?.id) continue;
			const prior = runs.get(patch.id);
			if (prior) Object.assign(prior, patch);
			else if (
				patch.command &&
				patch.cwd &&
				patch.mode &&
				patch.status &&
				patch.delivery &&
				patch.startedAt
			) {
				runs.set(patch.id, {
					...patch,
					logBytes: patch.logBytes ?? 0,
					log: logStore?.open(patch.id),
					generation: branchGeneration,
				} as BackgroundProcessRun);
			}
		}
		for (const run of runs.values()) {
			if (run.status === "running") {
				run.status = "failed";
				run.output = reason;
				run.finishedAt = Date.now();
				run.delivery = "pending";
				persist(run);
			}
			if (run.delivery === "pending") deliver(run);
		}
		prune();
		updateStatus();
	};
	const recentRuns = () =>
		[...runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECENT_RUNS);

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		logStore = new ProcessLogStore({ root: sessionLogDirectory(ctx.sessionManager.getSessionId()) });
		restore(ctx, "Parent session restarted before process completion.");
	});
	pi.on("session_tree", (_event, ctx) => {
		currentCtx = ctx;
		restore(ctx, "Parent changed session branch before process completion.");
	});
	pi.on("agent_settled", () => {
		for (const run of runs.values()) {
			if (run.delivery !== "pending") continue;
			if (acknowledge(run)) continue;
			run.deliveryQueued = false;
			deliver(run);
		}
	});
	pi.on("session_shutdown", () => {
		branchGeneration++;
		for (const run of runs.values()) run.handle?.stop();
		runs.clear();
		logStore = undefined;
		currentCtx = undefined;
	});

	pi.registerTool({
		name: "background_process",
		label: "Background Process",
		description:
			"Run an attached command tree asynchronously with private rotating logs. Use mode=wait for finite watches/checks and mode=service for long-running applications; self-daemonizing commands are unsupported.",
		parameters: BackgroundProcessParams,
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const cwd = resolve(ctx.cwd, params.cwd ?? ctx.cwd);
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Invalid process CWD: ${cwd}`);
			if (!params.command.trim()) throw new Error("Process command cannot be empty");
			if (Buffer.byteLength(params.command) > MAX_COMMAND_BYTES) {
				throw new Error(`Process command exceeds ${MAX_COMMAND_BYTES} bytes`);
			}
			const running = [...runs.values()].filter((run) => run.status === "running").length;
			if (running >= MAX_CONCURRENT_RUNS) throw new Error(`Process concurrency limit reached (${running}).`);

			let id = newId();
			while (runs.has(id)) id = newId();
			if (!logStore) throw new Error("Process log store is unavailable");
			const log = logStore.create(id);
			const run: BackgroundProcessRun = {
				id,
				command: truncateProcessText(params.command, MAX_COMMAND_BYTES),
				cwd,
				mode: params.mode,
				timeoutSeconds: params.timeoutSeconds,
				status: "running",
				delivery: "none",
				startedAt: Date.now(),
				logBytes: 0,
				log,
				generation: branchGeneration,
			};
			runs.set(id, run);
			persist(run);

			void runBackgroundProcess({
				command: params.command,
				cwd,
				mode: params.mode,
				timeoutSeconds: params.timeoutSeconds,
				log,
				onSpawn: (handle) => {
					if (!ownsProcess(runs, run, branchGeneration)) return handle.stop();
					run.handle = handle;
					run.pid = handle.pid;
					persist(run);
					updateStatus();
				},
			})
				.then((result) => {
					if (ownsProcess(runs, run, branchGeneration)) finish(run, result);
				})
				.catch((error: unknown) => {
					if (ownsProcess(runs, run, branchGeneration)) fail(run, error);
				});

			return {
				content: [{ type: "text", text: `started ${id} mode=${params.mode} pid=${run.pid ?? "pending"}` }],
				details: { id, mode: params.mode, pid: run.pid },
			};
		},
	});

	pi.registerTool({
		name: "process_control",
		label: "Process Control",
		description: "Inspect, search bounded logs for, or stop a session-owned background process.",
		parameters: ProcessControlParams,
		async execute(_toolCallId, params) {
			if (params.action === "status") {
				if (params.id) {
					const run = runs.get(params.id);
					if (!run) throw new Error(`Unknown process: ${params.id}`);
					return {
						content: [
							{ type: "text", text: truncateProcessText(detailedProcessStatus(run), MAX_STATUS_BYTES) },
						],
						details: { id: run.id, status: run.status, mode: run.mode } as Record<string, unknown>,
					};
				}
				const recent = recentRuns();
				return {
					content: [
						{
							type: "text",
							text: recent.length ? recent.map(compactProcessStatus).join("\n") : "0 processes",
						},
					],
					details: {} as Record<string, unknown>,
				};
			}
			if (!params.id) throw new Error(`action=${params.action} requires id`);
			const run = runs.get(params.id);
			if (!run) throw new Error(`Unknown process: ${params.id}`);
			if (params.action === "search") {
				if (!params.query) throw new Error("action=search requires query");
				const result = run.log?.search(params.query, params.limit);
				if (!result) throw new Error(`No retained log for process ${params.id}`);
				run.logBytes = run.log?.retainedBytes() ?? run.logBytes;
				return {
					content: [{ type: "text", text: result.text }],
					details: { id: run.id, matches: result.matches, logBytes: run.logBytes } as Record<string, unknown>,
				};
			}
			if (!stop(run)) throw new Error(`Process ${params.id} is ${run.status}`);
			return {
				content: [{ type: "text", text: `stopping ${params.id}` }],
				details: { id: run.id } as Record<string, unknown>,
			};
		},
	});

	pi.registerCommand("ps", {
		description: "Show session-owned background processes",
		handler: async (args, ctx) => {
			const id = args.trim();
			if (id) {
				const run = runs.get(id);
				ctx.ui.notify(
					run ? detailedProcessStatus(run, false) : `Unknown process: ${id}`,
					run ? "info" : "warning",
				);
				return;
			}
			const recent = recentRuns();
			ctx.ui.notify(
				recent.length
					? truncateProcessText(
							recent
								.map((run) => `${compactProcessStatus(run)}\n  ${commandSummary(run.command)}`)
								.join("\n"),
							MAX_STATUS_BYTES,
						)
					: "0 processes",
				"info",
			);
		},
	});

	pi.registerCommand("stop", {
		description: "Stop one or all session-owned background processes",
		handler: async (args, ctx) => {
			const target = args.trim();
			if (!target) {
				ctx.ui.notify("Usage: /stop <process-id|all>", "warning");
				return;
			}
			if (target === "all") {
				const count = [...runs.values()].filter(stop).length;
				ctx.ui.notify(
					count ? `Stopping ${count} process${count === 1 ? "" : "es"}.` : "0 running processes",
					"info",
				);
				return;
			}
			const run = runs.get(target);
			ctx.ui.notify(
				run && stop(run) ? `Stopping ${target}.` : `Process ${target} is not running.`,
				run ? "info" : "warning",
			);
		},
	});
}
