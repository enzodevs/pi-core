import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { createWriteStream, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const ENTRY_TYPE = "pi-core-monitor-run";
const RESULT_TYPE = "pi-core-monitor-result";
const STATUS_ID = "pi-core-background-monitors";
const MAX_COMMAND_BYTES = 4 * 1024;
const MAX_OUTPUT_BYTES = 12 * 1024;
const MAX_PUSH_BYTES = 4 * 1024;
const MAX_OUTPUT_LINES = 500;
const MAX_RECENT_RUNS = 20;

const MonitorParams = Type.Object({
	command: Type.String({ description: "Shell command to monitor asynchronously" }),
	cwd: Type.Optional(Type.String({ description: "Working directory; defaults to the parent CWD" })),
	timeoutSeconds: Type.Optional(
		Type.Integer({
			minimum: 1,
			maximum: 86_400,
			description: "Safety deadline in seconds; not the polling window",
		}),
	),
});

const MonitorControlParams = Type.Object({
	action: Type.Union([Type.Literal("status"), Type.Literal("stop")]),
	id: Type.Optional(Type.String({ description: "Monitor ID; omit for status of all runs" })),
});

type MonitorStatus = "running" | "complete" | "failed" | "stopped" | "timed_out";
type DeliveryStatus = "none" | "pending" | "delivered";

interface MonitorHandle {
	stop(): void;
}

export interface MonitorRun {
	id: string;
	command: string;
	cwd: string;
	timeoutSeconds?: number;
	status: MonitorStatus;
	delivery: DeliveryStatus;
	startedAt: number;
	finishedAt?: number;
	exitCode?: number | null;
	output?: string;
	fullOutputPath?: string;
	handle?: MonitorHandle;
	deliveryQueued?: boolean;
	generation: number;
}

export interface PersistedMonitorRun
	extends Partial<Omit<MonitorRun, "handle" | "deliveryQueued" | "generation">> {
	id: string;
}

interface CommandResult {
	status: MonitorStatus;
	exitCode: number | null;
	output: string;
	fullOutputPath: string;
}

export function truncateMonitorText(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	const marker = `\n[truncated: showing last ${maxBytes} of ${bytes.length} bytes]`;
	const tailBytes = Math.max(0, maxBytes - Buffer.byteLength(marker));
	const tail = bytes
		.subarray(bytes.length - tailBytes)
		.toString("utf8")
		.replace(/^�/u, "");
	return `${marker}${tail}`;
}

export function boundedMonitorTail(text: string): string {
	const lines = text.split("\n");
	const lineBounded = lines.length > MAX_OUTPUT_LINES ? lines.slice(-MAX_OUTPUT_LINES).join("\n") : text;
	const prefix =
		lines.length > MAX_OUTPUT_LINES ? `[truncated: showing last ${MAX_OUTPUT_LINES} lines]\n` : "";
	return truncateMonitorText(`${prefix}${lineBounded}`, MAX_OUTPUT_BYTES);
}

function capturedMonitorTail(tail: Buffer, totalBytes: number): string {
	const decoded = tail.toString("utf8").replace(/^�/u, "");
	const lines = decoded.split("\n");
	const lineTruncated = lines.length > MAX_OUTPUT_LINES;
	const body = lineTruncated ? lines.slice(-MAX_OUTPUT_LINES).join("\n") : decoded;
	const truncated = totalBytes > Buffer.byteLength(decoded) || lineTruncated;
	if (!truncated) return body.trimEnd();

	const marker = `[truncated: showing output tail; full stream was ${totalBytes} bytes]\n`;
	const budget = MAX_OUTPUT_BYTES - Buffer.byteLength(marker);
	const bytes = Buffer.from(body);
	const start = Math.max(0, bytes.length - budget);
	const bounded = completeLineTail(bytes.subarray(start), start > 0 && bytes[start - 1] !== 0x0a);
	return `${marker}${bounded.trimEnd()}`;
}

function completeLineTail(bytes: Buffer, startsMidLine: boolean): string {
	const decoded = bytes.toString("utf8").replace(/^�/u, "");
	if (!startsMidLine) return decoded;
	const newline = decoded.indexOf("\n");
	return newline >= 0 ? decoded.slice(newline + 1) : decoded;
}

function newId(): string {
	return randomBytes(4).toString("hex");
}

function killProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	try {
		if (process.platform === "win32") child.kill(signal);
		else process.kill(-child.pid, signal);
	} catch {
		child.kill(signal);
	}
}

export async function runMonitorCommand(
	command: string,
	cwd: string,
	timeoutSeconds: number | undefined,
	onSpawn: (handle: MonitorHandle) => void,
): Promise<CommandResult> {
	const outputPath = resolve(tmpdir(), `pi-monitor-${randomBytes(8).toString("hex")}.log`);
	const output = createWriteStream(outputPath, { mode: 0o600 });

	return new Promise<CommandResult>((resolveResult, reject) => {
		const child = spawn("bash", ["-c", command], {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		child.stdin.end();
		let tail = Buffer.alloc(0);
		let totalOutputBytes = 0;
		let requestedStatus: MonitorStatus | undefined;
		let settled = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;

		const append = (chunk: Buffer) => {
			output.write(chunk);
			totalOutputBytes += chunk.length;
			tail = Buffer.concat([tail, chunk]);
			if (tail.length > MAX_OUTPUT_BYTES * 2) tail = tail.subarray(tail.length - MAX_OUTPUT_BYTES * 2);
		};
		const requestStop = (status: MonitorStatus) => {
			if (settled || requestedStatus) return;
			requestedStatus = status;
			killProcess(child, "SIGTERM");
			setTimeout(() => killProcess(child, "SIGKILL"), 1_000).unref();
		};
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			const status = requestedStatus ?? (exitCode === 0 ? "complete" : "failed");
			output.end(() =>
				resolveResult({
					status,
					exitCode,
					output: capturedMonitorTail(tail, totalOutputBytes),
					fullOutputPath: outputPath,
				}),
			);
		};

		onSpawn({ stop: () => requestStop("stopped") });
		if (timeoutSeconds) {
			timeout = setTimeout(() => requestStop("timed_out"), timeoutSeconds * 1_000);
			timeout.unref();
		}
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			output.end(() => reject(error));
		});
		child.on("close", finish);
	});
}

export function ownsMonitor(
	runs: ReadonlyMap<string, MonitorRun>,
	run: MonitorRun,
	generation: number,
): boolean {
	return runs.get(run.id) === run && run.generation === generation;
}

export function snapshotMonitor(run: MonitorRun, transition = false): PersistedMonitorRun {
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
		command: truncateMonitorText(run.command, MAX_COMMAND_BYTES),
		cwd: run.cwd,
		timeoutSeconds: run.timeoutSeconds,
		status: run.status,
		delivery: run.delivery,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		exitCode: run.exitCode,
		output: run.output ? boundedMonitorTail(run.output) : undefined,
		fullOutputPath: run.fullOutputPath,
	};
}

function compactStatus(run: MonitorRun): string {
	const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1_000));
	return `${run.id} ${run.status} ${seconds}s ${basename(run.cwd)}`;
}

export function monitorCompletionText(run: MonitorRun, maxBytes = MAX_PUSH_BYTES): string {
	const pathLine = run.fullOutputPath ? `\nfull: ${run.fullOutputPath}` : "";
	const header = `monitor: ${run.id}\nstatus: ${run.status}\nexit: ${run.exitCode ?? "none"}${pathLine}\n\n`;
	const bodyBudget = Math.max(0, maxBytes - Buffer.byteLength(header));
	const body = run.output || "No output.";
	const bytes = Buffer.from(body);
	if (bytes.length <= bodyBudget) return `${header}${body}`;

	const marker = "[truncated: showing output tail]\n";
	const tailBudget = Math.max(0, bodyBudget - Buffer.byteLength(marker));
	const start = Math.max(0, bytes.length - tailBudget);
	const tail = completeLineTail(bytes.subarray(start), start > 0 && bytes[start - 1] !== 0x0a);
	return `${header}${marker}${tail}`;
}

export default function backgroundMonitor(pi: ExtensionAPI): void {
	const runs = new Map<string, MonitorRun>();
	let currentCtx: ExtensionContext | undefined;
	let branchGeneration = 0;

	const updateStatus = () => {
		if (!currentCtx) return;
		const count = [...runs.values()].filter((run) => run.status === "running").length;
		try {
			currentCtx.ui.setStatus(STATUS_ID, count ? `◉ ${count} monitor${count === 1 ? "" : "s"}` : undefined);
		} catch {
			// Session replacement can invalidate the old UI context.
		}
	};
	const persist = (run: MonitorRun, transition = false) => {
		try {
			pi.appendEntry(ENTRY_TYPE, snapshotMonitor(run, transition));
			return true;
		} catch {
			currentCtx?.ui.notify(`Could not persist monitor ${run.id} state.`, "warning");
			return false;
		}
	};
	const prune = () => {
		const finished = [...runs.values()]
			.filter((run) => run.status !== "running")
			.sort((a, b) => b.startedAt - a.startedAt);
		for (const run of finished.slice(MAX_RECENT_RUNS)) runs.delete(run.id);
	};
	const completionPresent = (run: MonitorRun) =>
		currentCtx?.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== RESULT_TYPE) return false;
			return (entry.details as { id?: unknown } | undefined)?.id === run.id;
		}) ?? false;
	const acknowledge = (run: MonitorRun) => {
		if (!completionPresent(run)) return false;
		run.delivery = "delivered";
		run.deliveryQueued = false;
		persist(run, true);
		return true;
	};
	const deliver = (run: MonitorRun) => {
		if (run.status === "running" || run.delivery === "delivered" || run.deliveryQueued) return;
		if (acknowledge(run)) return;
		try {
			pi.sendMessage(
				{
					customType: RESULT_TYPE,
					content: monitorCompletionText(run),
					display: true,
					details: { id: run.id },
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			run.deliveryQueued = true;
		} catch {
			run.delivery = "pending";
			run.deliveryQueued = false;
			currentCtx?.ui.notify(`Monitor ${run.id} finished; delivery will retry.`, "warning");
		}
	};
	const finish = (run: MonitorRun, result: CommandResult) => {
		run.status = result.status;
		run.exitCode = result.exitCode;
		run.output = boundedMonitorTail(result.output);
		run.fullOutputPath = result.fullOutputPath;
		run.finishedAt = Date.now();
		run.handle = undefined;
		run.delivery = "pending";
		run.deliveryQueued = false;
		persist(run);
		updateStatus();
		deliver(run);
		prune();
	};
	const fail = (run: MonitorRun, error: unknown) =>
		finish(run, {
			status: "failed",
			exitCode: null,
			output: error instanceof Error ? error.message : String(error),
			fullOutputPath: run.fullOutputPath ?? "",
		});
	const restore = (ctx: ExtensionContext, reason: string) => {
		branchGeneration++;
		for (const run of runs.values()) run.handle?.stop();
		runs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const patch = entry.data as PersistedMonitorRun;
			if (!patch?.id) continue;
			const prior = runs.get(patch.id);
			if (prior) Object.assign(prior, patch);
			else if (patch.command && patch.cwd && patch.status && patch.delivery && patch.startedAt) {
				runs.set(patch.id, { ...patch, generation: branchGeneration } as MonitorRun);
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

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		restore(ctx, "Parent session restarted before monitor completion.");
	});
	pi.on("session_tree", (_event, ctx) => {
		currentCtx = ctx;
		restore(ctx, "Parent changed session branch before monitor completion.");
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
		for (const run of runs.values()) run.handle?.stop();
		currentCtx = undefined;
	});

	pi.registerTool({
		name: "background_monitor",
		label: "Background Monitor",
		description:
			"Run a shell command asynchronously and push one durable, bounded result when it exits. The command must block until the watched operation is terminal; timeoutSeconds is only a safety deadline.",
		parameters: MonitorParams,
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const cwd = resolve(ctx.cwd, params.cwd ?? ctx.cwd);
			if (!existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Invalid monitor CWD: ${cwd}`);
			if (!params.command.trim()) throw new Error("Monitor command cannot be empty");

			let id = newId();
			while (runs.has(id)) id = newId();
			const run: MonitorRun = {
				id,
				command: truncateMonitorText(params.command, MAX_COMMAND_BYTES),
				cwd,
				timeoutSeconds: params.timeoutSeconds,
				status: "running",
				delivery: "none",
				startedAt: Date.now(),
				generation: branchGeneration,
			};
			runs.set(id, run);
			persist(run);

			void runMonitorCommand(params.command, cwd, params.timeoutSeconds, (handle) => {
				if (!ownsMonitor(runs, run, branchGeneration)) return handle.stop();
				run.handle = handle;
				updateStatus();
			})
				.then((result) => {
					if (ownsMonitor(runs, run, branchGeneration)) finish(run, result);
				})
				.catch((error: unknown) => {
					if (ownsMonitor(runs, run, branchGeneration)) fail(run, error);
				});

			return { content: [{ type: "text", text: `monitoring ${id}` }], details: { id } };
		},
	});

	pi.registerTool({
		name: "monitor_control",
		label: "Monitor Control",
		description: "Get compact monitor status or stop a running monitor.",
		parameters: MonitorControlParams,
		async execute(_toolCallId, params) {
			if (params.action === "status") {
				if (params.id) {
					const run = runs.get(params.id);
					if (!run) throw new Error(`Unknown monitor: ${params.id}`);
					const body =
						run.status === "running"
							? compactStatus(run)
							: `${compactStatus(run)}\n${monitorCompletionText(run, MAX_OUTPUT_BYTES)}`;
					return { content: [{ type: "text", text: boundedMonitorTail(body) }], details: {} };
				}
				const recent = [...runs.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECENT_RUNS);
				return {
					content: [
						{ type: "text", text: recent.length ? recent.map(compactStatus).join("\n") : "0 monitors" },
					],
					details: {},
				};
			}
			if (!params.id) throw new Error("action=stop requires id");
			const run = runs.get(params.id);
			if (!run) throw new Error(`Unknown monitor: ${params.id}`);
			if (run.status !== "running" || !run.handle) throw new Error(`Monitor ${params.id} is ${run.status}`);
			run.handle.stop();
			return { content: [{ type: "text", text: `stopping ${params.id}` }], details: {} };
		},
	});
}
