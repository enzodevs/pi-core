import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, open, readdir, rename, rm, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { formatSize } from "@earendil-works/pi-coding-agent";

const KERNEL_PATH = fileURLToPath(new URL("./kernel.py", import.meta.url));
export const MAX_OUTPUT_BYTES = 30 * 1024;
const HEAD_BYTES = 8 * 1024;
const HEAD_LINES = 150;
const TAIL_LINES = 450;
const CELL_TIMEOUT_MS = 10 * 60_000;
const READY_TIMEOUT_MS = 30_000;
const OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60_000;
/** Must match CAPTURE_LIMIT in kernel.py: a running cell writing more is stopped. */
const MAX_CAPTURE_BYTES = 64 * 1024 * 1024;
/** Saved full outputs beyond this total are pruned, oldest first. */
const MAX_SAVED_OUTPUT_BYTES = 256 * 1024 * 1024;

export type CellStatus = "ok" | "error" | "interrupted" | "timeout" | "crashed";

export interface CellResult {
	status: CellStatus;
	/** Model-facing text: the (head+tail bounded) output plus any status notes. */
	text: string;
	/** Full output file, kept only when the text was truncated. */
	fullOutputPath?: string;
	totalBytes: number;
}

export interface KernelOptions {
	python: string;
	/** Default directory for a new kernel when a cell names none. */
	cwd: string;
	/** Truncated outputs are kept here (pruned after 7 days) so their paths stay valid across reloads. */
	outputDir: string;
	env?: NodeJS.ProcessEnv;
	kernelPath?: string;
	cellTimeoutMs?: number;
}

type Reply = { id?: number; status?: string; names?: string[]; ready?: boolean; overflow?: boolean };

const cancelledBeforeRunning: CellResult = {
	status: "interrupted",
	text: "[cancelled before running]",
	totalBytes: 0,
};
/** Captures of running cells; only finished, truncated outputs move up and are pruned. */
const ACTIVE_DIR = "active";

/** One persistent Python process. Cells run one at a time, in call order. */
export class PythonKernel {
	private proc?: ChildProcessWithoutNullStreams;
	private ready?: Promise<void>;
	private readonly waiters = new Map<number, (reply: Reply | undefined) => void>();
	private queue: Promise<unknown> = Promise.resolve();
	private readonly id = randomUUID().slice(0, 8);
	private nextId = 1;
	private cells = 0;
	private pruned = false;
	private stderrTail = "";
	/** Set when a started kernel died, so the next cell can say state was lost. */
	private lostState = false;
	private disposed = false;
	private rejectStart?: () => void;
	private onOverflow?: () => void;

	constructor(private readonly options: KernelOptions) {}

	/** Run a cell. `cwd` is the session directory; the kernel follows it when it changes. */
	exec(code: string, cwd?: string, signal?: AbortSignal): Promise<CellResult> {
		const run = this.queue.then(() => this.execNow(code, cwd, signal));
		this.queue = run.catch(() => undefined);
		return run;
	}

	/** User-defined names, or undefined when no kernel is running. */
	async names(): Promise<string[] | undefined> {
		if (!this.proc) return undefined;
		const reply = await this.request({ op: "names" }, 5_000);
		return reply?.names;
	}

	dispose(): void {
		this.disposed = true;
		this.kill();
	}

	/** Drop the current kernel; the next cell starts a fresh one without a "lost state" note. */
	reset(): void {
		this.kill();
		this.lostState = false;
	}

	private async execNow(code: string, cwd: string | undefined, signal?: AbortSignal): Promise<CellResult> {
		if (this.disposed) throw new Error("python kernel is shut down");
		if (signal?.aborted) return cancelledBeforeRunning;
		const directory = cwd ?? this.options.cwd;
		if (!existsSync(directory))
			return {
				status: "error",
				text: `Session directory unavailable: ${directory}; the cell was not run.`,
				totalBytes: 0,
			};
		let stopped: "interrupted" | "timeout" | "overflow" | undefined;
		// The host owns cancellation: it never trusts the cell to stop itself.
		const stop = (reason: NonNullable<typeof stopped>) => {
			stopped ??= reason;
			this.kill();
		};
		const onAbort = () => stop("interrupted");
		// Listen before starting the kernel, so an abort during startup is never missed.
		signal?.addEventListener("abort", onAbort, { once: true });
		let header: string | undefined;
		let timer: NodeJS.Timeout | undefined;
		let reply: Reply | undefined;
		const activePath = join(this.options.outputDir, ACTIVE_DIR, `${this.id}-${++this.cells}.txt`);
		const timeoutMs = this.options.cellTimeoutMs ?? CELL_TIMEOUT_MS;
		try {
			if (!this.proc) {
				if (this.lostState) header = "[new kernel: variables from the previous kernel are gone]";
				this.lostState = false;
				await this.prepareOutputDir();
				await this.start(directory);
			}
			if (stopped) return cancelledBeforeRunning;
			timer = setTimeout(() => stop("timeout"), timeoutMs);
			this.onOverflow = () => stop("overflow");
			reply = await this.request({ op: "exec", code, output: activePath, cwd: directory });
		} catch (error) {
			if (stopped) return cancelledBeforeRunning;
			throw error;
		} finally {
			clearTimeout(timer);
			this.onOverflow = undefined;
			signal?.removeEventListener("abort", onAbort);
		}
		const notes: string[] = [];
		let status: CellStatus;
		const reset = "the kernel and its process group were stopped; variables are gone";
		// After Esc the model may never see this result: the next call repeats the loss.
		if (stopped) this.lostState = true;
		if (stopped === "interrupted") {
			status = "interrupted";
			notes.push(`[interrupted: ${reset}]`);
		} else if (stopped === "timeout") {
			status = "timeout";
			notes.push(
				`[stopped after ${Math.round(timeoutMs / 1000)}s: ${reset}. Use background_process for long jobs]`,
			);
		} else if (stopped === "overflow") {
			status = "error";
			notes.push(
				`[stopped: output passed ${formatSize(MAX_CAPTURE_BYTES)}; ${reset}. Write large data to a file and print a summary]`,
			);
		} else if (!reply) {
			status = "crashed";
			const stderr = this.stderrTail.trim().split("\n").at(-1);
			notes.push(
				`[kernel died${stderr ? `: ${stderr}` : ""}; variables are lost and the next call starts a fresh kernel]`,
			);
			this.lostState = true;
		} else {
			status = reply.status === "ok" ? "ok" : "error";
			if (reply.overflow)
				notes.push(`[output passed ${formatSize(MAX_CAPTURE_BYTES)}; only its start was saved]`);
		}
		const output = await readOutput(activePath);
		if (output.missing && reply) {
			// The kernel wrote this file: never report a lost capture as an empty, successful cell.
			return {
				status: status === "ok" ? "error" : status,
				text: [header, `[output capture missing: ${activePath}]`, ...notes].filter(Boolean).join("\n"),
				totalBytes: 0,
			};
		}
		let savedPath: string | undefined;
		if (output.truncated) {
			savedPath = join(this.options.outputDir, basename(activePath));
			await rename(activePath, savedPath);
			const overflowed = stopped === "overflow" || reply?.overflow;
			notes.unshift(
				overflowed
					? `[output truncated; its first ${formatSize(MAX_CAPTURE_BYTES)} are saved in ${savedPath}]`
					: `[output truncated: ${formatSize(output.totalBytes)} total; full output: ${savedPath}]`,
			);
			await pruneSavedOutputs(this.options.outputDir, savedPath);
		} else {
			await rm(activePath, { force: true });
		}
		const body = output.text || (status === "ok" ? "(no output)" : "");
		const text = [header, body, ...notes].filter(Boolean).join("\n");
		return {
			status,
			text,
			totalBytes: output.totalBytes,
			...(savedPath ? { fullOutputPath: savedPath } : {}),
		};
	}

	private async prepareOutputDir(): Promise<void> {
		await mkdir(join(this.options.outputDir, ACTIVE_DIR), { recursive: true, mode: 0o700 });
		if (this.pruned) return;
		this.pruned = true;
		// Saved outputs age out; active captures left by a dead Pi only after the same delay.
		const cutoff = Date.now() - OUTPUT_RETENTION_MS;
		for (const directory of [this.options.outputDir, join(this.options.outputDir, ACTIVE_DIR)]) {
			for (const name of await readdir(directory).catch(() => [])) {
				const path = join(directory, name);
				const info = await stat(path).catch(() => undefined);
				if (info?.isFile() && info.mtimeMs < cutoff) await rm(path, { force: true });
			}
		}
	}

	private start(cwd: string): Promise<void> {
		const proc = spawn(this.options.python, ["-I", this.options.kernelPath ?? KERNEL_PATH], {
			cwd,
			env: this.options.env ?? process.env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: true, // own process group: interrupts and kills reach the cell's children
		});
		this.proc = proc;
		this.stderrTail = "";
		proc.stderr.on("data", (chunk: Buffer) => {
			this.stderrTail = (this.stderrTail + chunk.toString("utf8")).slice(-2_000);
		});
		proc.stdin.on("error", () => undefined);
		const lines = createInterface({ input: proc.stdout });
		let resolveReady: () => void = () => undefined;
		let rejectReady: (error: Error) => void = () => undefined;
		this.ready = new Promise<void>((resolve, reject) => {
			resolveReady = resolve;
			rejectReady = reject;
		});
		this.rejectStart = () => rejectReady(new Error("python kernel stopped during startup"));
		const readyTimer = setTimeout(() => {
			rejectReady(new Error("python kernel did not start within 30s"));
			this.kill();
		}, READY_TIMEOUT_MS);
		lines.on("line", (line) => {
			let reply: Reply;
			try {
				reply = JSON.parse(line) as Reply;
			} catch {
				return;
			}
			if (reply.ready) {
				clearTimeout(readyTimer);
				resolveReady();
				return;
			}
			if (reply.overflow && reply.id === undefined) {
				this.onOverflow?.();
				return;
			}
			if (reply.id === undefined) return;
			const waiter = this.waiters.get(reply.id);
			this.waiters.delete(reply.id);
			waiter?.(reply);
		});
		const onGone = (error?: Error) => {
			if (this.proc !== proc) return;
			clearTimeout(readyTimer);
			// The group outlives a crashed leader (os._exit, native crash): stop what it left running.
			if (proc.pid) killProcessGroup(proc.pid);
			this.proc = undefined;
			this.lostState = !this.disposed;
			const stderr = this.stderrTail.trim();
			rejectReady(
				error ??
					new Error(`python kernel exited during startup${stderr ? `: ${stderr.split("\n").at(-1)}` : ""}`),
			);
			for (const waiter of this.waiters.values()) waiter(undefined);
			this.waiters.clear();
		};
		proc.on("error", onGone);
		proc.on("exit", () => onGone());
		return this.ready;
	}

	private async request(
		message: { op: string; [key: string]: unknown },
		timeoutMs?: number,
	): Promise<Reply | undefined> {
		const proc = this.proc;
		if (!proc) return undefined;
		await this.ready;
		const id = this.nextId++;
		return new Promise((resolve) => {
			const timer = timeoutMs
				? setTimeout(() => {
						this.waiters.delete(id);
						resolve(undefined);
					}, timeoutMs)
				: undefined;
			this.waiters.set(id, (reply) => {
				if (timer) clearTimeout(timer);
				resolve(reply);
			});
			proc.stdin.write(`${JSON.stringify({ id, ...message })}\n`);
		});
	}

	/** Stop the kernel and its process group; waiting cells and startup resolve as gone. */
	private kill(): void {
		const pid = this.proc?.pid;
		if (!this.proc) return;
		this.proc = undefined;
		if (pid) killProcessGroup(pid);
		this.rejectStart?.();
		for (const waiter of this.waiters.values()) waiter(undefined);
		this.waiters.clear();
	}
}

/**
 * SIGKILL the kernel's process group, as Pi's own bash tool does: stopped first so a
 * shell cannot start its next command mid-kill. Children that leave the group
 * (setsid, daemons) are outside this boundary.
 */
function killProcessGroup(pid: number): void {
	for (const signal of ["SIGSTOP", "SIGKILL"] as const) {
		try {
			process.kill(-pid, signal);
		} catch {
			if (signal === "SIGKILL") {
				try {
					process.kill(pid, signal);
				} catch {}
			}
		}
	}
}

/** Keep saved full outputs under MAX_SAVED_OUTPUT_BYTES, deleting the oldest first. */
async function pruneSavedOutputs(directory: string, keep: string): Promise<void> {
	const files = [];
	for (const name of await readdir(directory).catch(() => [])) {
		const path = join(directory, name);
		const info = await stat(path).catch(() => undefined);
		if (info?.isFile()) files.push({ path, size: info.size, mtime: info.mtimeMs });
	}
	let total = files.reduce((sum, file) => sum + file.size, 0);
	for (const file of files.sort((a, b) => a.mtime - b.mtime)) {
		if (total <= MAX_SAVED_OUTPUT_BYTES) break;
		if (file.path === keep) continue;
		await rm(file.path, { force: true });
		total -= file.size;
	}
}

/**
 * Bound a cell's output to its beginning and end. Only the needed bytes are read,
 * so huge outputs never load whole; a single long line keeps a partial preview.
 */
async function readOutput(
	path: string,
): Promise<{ text: string; truncated: boolean; totalBytes: number; missing?: boolean }> {
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	try {
		handle = await open(path, "r");
	} catch {
		return { text: "", truncated: false, totalBytes: 0, missing: true };
	}
	try {
		const { size } = await handle.stat();
		const read = async (position: number, length: number) => {
			const buffer = Buffer.alloc(length);
			await handle?.read(buffer, 0, length, position);
			// Cut edges may split a UTF-8 character: drop the fragments instead of decoding them as U+FFFD.
			return utf8Aligned(buffer, position > 0, position + length < size).toString("utf8");
		};
		if (size <= MAX_OUTPUT_BYTES) {
			const lines = (await read(0, size)).replace(/\n$/, "").split("\n");
			if (lines.length <= HEAD_LINES + TAIL_LINES)
				return { text: lines.join("\n"), truncated: false, totalBytes: size };
			const omitted = lines.length - HEAD_LINES - TAIL_LINES;
			return {
				text: [
					...lines.slice(0, HEAD_LINES),
					`[… ${omitted} lines omitted …]`,
					...lines.slice(-TAIL_LINES),
				].join("\n"),
				truncated: true,
				totalBytes: size,
			};
		}
		const head = keepWholeLines(await read(0, HEAD_BYTES), "end")
			.split("\n")
			.slice(0, HEAD_LINES)
			.join("\n");
		const tailBytes = MAX_OUTPUT_BYTES - HEAD_BYTES;
		const tail = keepWholeLines((await read(size - tailBytes, tailBytes)).replace(/\n$/, ""), "start")
			.split("\n")
			.slice(-TAIL_LINES)
			.join("\n");
		const omitted = size - Buffer.byteLength(head) - Buffer.byteLength(tail);
		return {
			text: `${head}\n[… ${formatSize(Math.max(0, omitted))} omitted …]\n${tail}`,
			truncated: true,
			totalBytes: size,
		};
	} finally {
		await handle.close();
	}
}

/** Trim incomplete UTF-8 sequences at the cut start and/or end of a byte slice. */
function utf8Aligned(buffer: Buffer, cutStart: boolean, cutEnd: boolean): Buffer {
	const isContinuation = (byte: number | undefined) => byte !== undefined && (byte & 0xc0) === 0x80;
	let start = 0;
	if (cutStart) while (start < 3 && isContinuation(buffer[start])) start++;
	let end = buffer.length;
	if (cutEnd) {
		let lead = end - 1;
		while (lead > end - 4 && isContinuation(buffer[lead])) lead--;
		const byte = buffer[lead] ?? 0;
		const width = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1;
		if (lead >= start && end - lead < width) end = lead;
	}
	return buffer.subarray(start, end);
}

/** Drop the partial line at one edge of a slice, unless that would leave nothing. */
function keepWholeLines(text: string, partialAt: "start" | "end"): string {
	if (partialAt === "start") {
		const newline = text.indexOf("\n");
		return newline >= 0 && newline < text.length - 1 ? text.slice(newline + 1) : text;
	}
	const newline = text.lastIndexOf("\n");
	return newline > 0 ? text.slice(0, newline) : text;
}
