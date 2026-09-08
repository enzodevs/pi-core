import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { getHeadroomPaths } from "./paths.mjs";

export const MAX_JSON_BYTES = 256 * 1024;
const MAX_RESPONSE_BYTES = MAX_JSON_BYTES * 2;

// No shell, inherited credentials, Python user-site imports, or model downloads.
// A failed, oversized, cancelled, or unavailable worker leaves the tool result alone.
export function runWorker(
	command: string,
	args: string[],
	input: string,
	signal?: AbortSignal,
	timeoutMs = 2_000,
): Promise<string | undefined> {
	if (signal?.aborted || Buffer.byteLength(input) > MAX_JSON_BYTES) return Promise.resolve(undefined);
	return new Promise((resolve) => {
		const home = getHeadroomPaths().directory;
		const child = spawn(command, args, {
			stdio: ["pipe", "pipe", "pipe"],
			env: {
				PATH: process.env.PATH,
				HOME: home,
				XDG_CACHE_HOME: join(home, "cache"),
				HF_HUB_OFFLINE: "1",
				HF_HUB_DISABLE_TELEMETRY: "1",
				DO_NOT_TRACK: "1",
			},
		});
		let settled = false;
		let bytes = 0;
		let stderrBytes = 0;
		const chunks: Buffer[] = [];
		const finish = (value?: string) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			signal?.removeEventListener("abort", cancel);
			resolve(value);
		};
		const cancel = () => {
			child.kill("SIGKILL");
			finish();
		};
		const timer = setTimeout(cancel, timeoutMs);
		signal?.addEventListener("abort", cancel, { once: true });
		child.on("error", () => finish());
		child.stdin.on("error", cancel);
		child.stdout.on("data", (chunk: Buffer) => {
			bytes += chunk.length;
			if (bytes > MAX_RESPONSE_BYTES) cancel();
			else chunks.push(chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderrBytes += chunk.length;
			if (stderrBytes > 8_192) cancel();
		});
		child.on("close", (code) => {
			if (code !== 0) return finish();
			try {
				const result = JSON.parse(Buffer.concat(chunks).toString("utf8"));
				const hash = createHash("sha256").update(input).digest("hex");
				if (result?.sha256 === hash && typeof result.text === "string") finish(result.text);
				else finish();
			} catch {
				finish();
			}
		});
		child.stdin.end(input);
		if (signal?.aborted) cancel();
	});
}

export function headroomPython(): string {
	return process.env.PI_CORE_HEADROOM_PYTHON || getHeadroomPaths().python;
}

export function createJsonCompressor(
	worker: (input: string, signal?: AbortSignal) => Promise<string | undefined>,
) {
	let active = 0;
	return async (input: string, signal?: AbortSignal): Promise<string | undefined> => {
		// Parallel tool results must not fan out unbounded Python imports.
		// No queue: saturation leaves the original result intact immediately.
		if (active >= 2 || signal?.aborted) return;
		active++;
		try {
			return await worker(input, signal);
		} finally {
			active--;
		}
	};
}

export const compressJson = createJsonCompressor((input, signal) =>
	runWorker(headroomPython(), ["-I", fileURLToPath(new URL("./worker.py", import.meta.url))], input, signal),
);
