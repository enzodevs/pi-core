import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ProcessLog } from "./log-store.js";

const PROCESS_HOST_PATH = fileURLToPath(new URL("./process-host.js", import.meta.url));

const MAX_OUTPUT_BYTES = 12 * 1024;
const MAX_OUTPUT_LINES = 500;

export type ProcessMode = "wait" | "service";
export type ProcessStatus = "running" | "complete" | "failed" | "stopped" | "timed_out";

export interface ProcessHandle {
	pid?: number;
	stop(): void;
}

export interface ProcessResult {
	status: ProcessStatus;
	exitCode: number | null;
	output: string;
	logBytes: number;
}

export function truncateProcessText(text: string, maxBytes: number): string {
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

export function boundedProcessTail(text: string): string {
	const lines = text.split("\n");
	const lineBounded = lines.length > MAX_OUTPUT_LINES ? lines.slice(-MAX_OUTPUT_LINES).join("\n") : text;
	const prefix =
		lines.length > MAX_OUTPUT_LINES ? `[truncated: showing last ${MAX_OUTPUT_LINES} lines]\n` : "";
	return truncateProcessText(`${prefix}${lineBounded}`, MAX_OUTPUT_BYTES);
}

function completeLineTail(bytes: Buffer, startsMidLine: boolean): string {
	const decoded = bytes.toString("utf8").replace(/^�/u, "");
	if (!startsMidLine) return decoded;
	const newline = decoded.indexOf("\n");
	return newline >= 0 ? decoded.slice(newline + 1) : decoded;
}

function capturedProcessTail(tail: Buffer, totalBytes: number): string {
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

function killProcess(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
	if (!child.pid) return;
	if (process.platform === "win32") {
		const args = ["/PID", String(child.pid), "/T"];
		if (signal === "SIGKILL") args.push("/F");
		const killer = spawn("taskkill", args, { stdio: "ignore", windowsHide: true });
		killer.on("error", () => undefined);
		return;
	}
	try {
		process.kill(-child.pid, signal);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
}

export async function runBackgroundProcess(options: {
	command: string;
	cwd: string;
	mode: ProcessMode;
	timeoutSeconds?: number;
	log: ProcessLog;
	onSpawn: (handle: ProcessHandle) => void;
}): Promise<ProcessResult> {
	return new Promise<ProcessResult>((resolve, reject) => {
		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(process.execPath, [PROCESS_HOST_PATH], {
				cwd: options.cwd,
				detached: process.platform !== "win32",
				env: { ...process.env, PI_CORE_BACKGROUND_PROCESS_COMMAND: options.command },
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			});
		} catch (error) {
			options.log.close();
			reject(error);
			return;
		}
		child.stdin.end();
		let tail = Buffer.alloc(0);
		let totalOutputBytes = 0;
		let requestedStatus: ProcessStatus | undefined;
		let captureError: unknown;
		let settled = false;
		let childExited = false;
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let forceKillTimeout: ReturnType<typeof setTimeout> | undefined;

		const requestStop = (status: ProcessStatus) => {
			if (settled || requestedStatus || childExited) return;
			requestedStatus = status;
			if (process.platform === "win32") {
				// taskkill /T /F is the only stock Windows primitive that reliably owns the descendant tree.
				killProcess(child, "SIGKILL");
				return;
			}
			killProcess(child, "SIGTERM");
			forceKillTimeout = setTimeout(() => killProcess(child, "SIGKILL"), 1_000);
			forceKillTimeout.unref();
		};
		const append = (chunk: Buffer) => {
			try {
				options.log.append(chunk);
				totalOutputBytes += chunk.length;
				tail = Buffer.concat([tail, chunk]);
				if (tail.length > MAX_OUTPUT_BYTES * 2) tail = tail.subarray(tail.length - MAX_OUTPUT_BYTES * 2);
			} catch (error) {
				captureError = error;
				requestStop("failed");
			}
		};
		const finish = (exitCode: number | null) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
			options.log.close();
			if (captureError) return reject(captureError);
			const status =
				requestedStatus ?? (options.mode === "service" ? "failed" : exitCode === 0 ? "complete" : "failed");
			resolve({
				status,
				exitCode,
				output: capturedProcessTail(tail, totalOutputBytes),
				logBytes: options.log.retainedBytes(),
			});
		};

		options.onSpawn({ pid: child.pid, stop: () => requestStop("stopped") });
		if (options.timeoutSeconds) {
			timeout = setTimeout(() => requestStop("timed_out"), options.timeoutSeconds * 1_000);
			timeout.unref();
		}
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("exit", () => {
			childExited = true;
			if (timeout) clearTimeout(timeout);
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
			forceKillTimeout = undefined;
		});
		child.on("error", (error) => {
			if (settled) return;
			settled = true;
			if (timeout) clearTimeout(timeout);
			if (forceKillTimeout) clearTimeout(forceKillTimeout);
			options.log.close();
			reject(error);
		});
		child.on("close", finish);
	});
}
