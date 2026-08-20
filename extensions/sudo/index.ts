import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { open, unlink } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { resolve } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { Type } from "typebox";

const STATUS_ID = "pi-core-sudo";
const MAX_COMMAND_BYTES = 8 * 1024;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

const SudoParams = Type.Object({
	command: Type.String({ description: "Command to execute with temporary root privileges" }),
});

interface RunResult {
	exitCode: number | null;
	output: string;
	fullOutputPath?: string;
}

interface SudoHandle {
	stop(): void;
}

export function boundSudoOutput(output: string): { content: string; truncated: boolean } {
	const lines = output.split("\n");
	const lineBounded = lines.length > MAX_OUTPUT_LINES ? lines.slice(-MAX_OUTPUT_LINES).join("\n") : output;
	const bytes = Buffer.from(lineBounded);
	const byteBounded =
		bytes.length > MAX_OUTPUT_BYTES
			? bytes
					.subarray(bytes.length - MAX_OUTPUT_BYTES)
					.toString("utf8")
					.replace(/^�/u, "")
			: lineBounded;
	const truncated = lines.length > MAX_OUTPUT_LINES || Buffer.byteLength(output) > MAX_OUTPUT_BYTES;
	return {
		content: truncated
			? `[truncated: showing output tail; full stream was ${Buffer.byteLength(output)} bytes]\n${byteBounded}`
			: byteBounded,
		truncated,
	};
}

function abortError(): Error {
	return Object.assign(new Error("sudo cancelled"), { name: "AbortError" });
}

function scheduleForceKill(pid: number, password: Buffer) {
	const target = process.platform === "win32" ? String(pid) : `-${pid}`;
	const killer = spawn(
		"sudo",
		["-k", "-S", "-p", "", "--", "bash", "-c", 'sleep 1; kill -KILL -- "$1"', "pi-sudo-kill", target],
		{ stdio: ["pipe", "ignore", "ignore"] },
	);
	killer.on("error", () => {});
	killer.stdin.on("error", () => {});
	killer.stdin.end(Buffer.concat([password, Buffer.from("\n")]));
	return killer;
}

export async function runSudo(
	command: string,
	cwd: string,
	password: Buffer,
	signal: AbortSignal | undefined,
	onSpawn: (handle: SudoHandle) => void,
): Promise<RunResult> {
	if (signal?.aborted) throw abortError();
	const outputPath = resolve(tmpdir(), `pi-sudo-${randomBytes(8).toString("hex")}.log`);
	const outputFile = await open(outputPath, "wx", 0o600);
	if (signal?.aborted) {
		await outputFile.close();
		await unlink(outputPath);
		throw abortError();
	}

	return new Promise((resolveResult, reject) => {
		const output = outputFile.createWriteStream();
		// -k forces sudo to consume this invocation's password instead of forwarding it
		// to the command when an external sudo timestamp is already valid.
		const child = spawn("sudo", ["-k", "-S", "-p", "", "--", "bash", "-c", command], {
			cwd,
			detached: process.platform !== "win32",
			stdio: ["pipe", "pipe", "pipe"],
		});
		let tail = Buffer.alloc(0);
		let totalBytes = 0;
		let totalNewlines = 0;
		let lastByte: number | undefined;
		let settled = false;
		let stopping = false;
		let backpressured = false;
		let killEscalator: ReturnType<typeof spawn> | undefined;

		const cleanup = () => {
			signal?.removeEventListener("abort", stop);
			killEscalator?.kill("SIGTERM");
			killEscalator = undefined;
		};
		const fail = (error: unknown) => {
			if (settled) return;
			settled = true;
			output.destroy();
			cleanup();
			void unlink(outputPath).catch(() => {});
			reject(error);
		};
		const stop = () => {
			if (stopping) return;
			stopping = true;
			if (!child.pid) {
				child.kill("SIGTERM");
				return;
			}
			try {
				if (process.platform === "win32") child.kill("SIGTERM");
				else process.kill(-child.pid, "SIGTERM");
			} catch {
				child.kill("SIGTERM");
			}
			killEscalator = scheduleForceKill(child.pid, password);
		};
		const append = (chunk: Buffer) => {
			if (!output.write(chunk) && !backpressured) {
				backpressured = true;
				child.stdout.pause();
				child.stderr.pause();
				output.once("drain", () => {
					backpressured = false;
					child.stdout.resume();
					child.stderr.resume();
				});
			}
			totalBytes += chunk.length;
			for (const byte of chunk) if (byte === 0x0a) totalNewlines++;
			if (chunk.length) lastByte = chunk[chunk.length - 1];
			tail = Buffer.concat([tail, chunk]);
			if (tail.length > MAX_OUTPUT_BYTES * 2) tail = tail.subarray(tail.length - MAX_OUTPUT_BYTES * 2);
		};

		onSpawn({ stop });
		signal?.addEventListener("abort", stop, { once: true });
		if (signal?.aborted) stop();
		output.on("error", (error) => {
			stop();
			fail(error);
		});
		child.stdout.on("data", append);
		child.stderr.on("data", append);
		child.on("error", fail);
		child.on("close", (exitCode) => {
			if (settled) return;
			output.end(async () => {
				if (settled) return;
				settled = true;
				cleanup();
				try {
					const totalLines = totalBytes === 0 ? 0 : totalNewlines + (lastByte === 0x0a ? 0 : 1);
					const decoded = tail.toString("utf8").replace(/^�/u, "").trimEnd();
					const tailLines = decoded.split("\n");
					const lineBounded =
						tailLines.length > MAX_OUTPUT_LINES ? tailLines.slice(-MAX_OUTPUT_LINES).join("\n") : decoded;
					const bytes = Buffer.from(lineBounded);
					const body =
						bytes.length > MAX_OUTPUT_BYTES
							? bytes
									.subarray(bytes.length - MAX_OUTPUT_BYTES)
									.toString("utf8")
									.replace(/^�/u, "")
							: lineBounded;
					const truncated = totalBytes > MAX_OUTPUT_BYTES || totalLines > MAX_OUTPUT_LINES;
					if (!truncated) await unlink(outputPath);
					resolveResult({
						exitCode,
						output: truncated
							? `[truncated: showing output tail; full stream was ${totalBytes} bytes]\n${body}`
							: body,
						fullOutputPath: truncated ? outputPath : undefined,
					});
				} catch (error) {
					void unlink(outputPath).catch(() => {});
					reject(error);
				}
			});
		});
		child.stdin.on("error", () => {});
		child.stdin.end(Buffer.concat([password, Buffer.from("\n")]));
	});
}

async function promptPassword(ctx: ExtensionContext): Promise<Buffer | undefined> {
	if (ctx.mode !== "tui") throw new Error("sudo password entry requires Pi's interactive TUI");
	const username = userInfo().username;
	const value = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
		let password = "";
		return {
			render(width: number) {
				return [
					truncateToWidth(theme.fg("accent", theme.bold(`sudo password for ${username}`)), width),
					truncateToWidth(`${theme.fg("muted", "> ")}${"•".repeat([...password].length)}`, width),
					truncateToWidth(theme.fg("dim", "enter confirm • esc cancel"), width),
				];
			},
			handleInput(data: string) {
				if (matchesKey(data, Key.enter)) return done(password);
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) return done(null);
				if (matchesKey(data, Key.backspace)) password = [...password].slice(0, -1).join("");
				else if (!data.includes("\u001b") && !data.includes("\n") && !data.includes("\r")) password += data;
				tui.requestRender();
			},
			invalidate() {},
		};
	});
	return value === null ? undefined : Buffer.from(value);
}

function revokeSudo(password: Buffer | undefined): void {
	password?.fill(0);
	const child = spawn("sudo", ["-k"], { detached: false, stdio: "ignore" });
	child.unref();
}

export default function sudoExtension(pi: ExtensionAPI): void {
	let password: Buffer | undefined;
	let currentCtx: ExtensionContext | undefined;
	let activeHandle: SudoHandle | undefined;
	let running = false;

	const setStatus = () => {
		currentCtx?.ui.setStatus(
			STATUS_ID,
			password ? currentCtx.ui.theme.fg("warning", running ? "sudo: running" : "sudo: unlocked") : undefined,
		);
	};
	const lock = () => {
		revokeSudo(password);
		password = undefined;
		setStatus();
	};

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		password = undefined;
		setStatus();
	});
	pi.on("session_shutdown", () => {
		activeHandle?.stop();
		activeHandle = undefined;
		lock();
		currentCtx = undefined;
	});

	pi.registerCommand("sudo-lock", {
		description: "Forget the temporary sudo credential now",
		handler: async (_args, ctx) => {
			lock();
			ctx.ui.notify("Temporary sudo access locked", "info");
		},
	});

	pi.registerTool({
		name: "sudo",
		label: "Sudo",
		description:
			"Run one shell command with temporary root privileges after explicit user approval. Password entry is masked and stays outside model/session context. Output is bounded to 2000 lines/50KB.",
		parameters: SudoParams,
		async execute(_toolCallId, params, signal, _update, ctx) {
			if (Buffer.byteLength(params.command) > MAX_COMMAND_BYTES) throw new Error("sudo command exceeds 8KB");
			if (!params.command.trim()) throw new Error("sudo command cannot be empty");
			if (running) throw new Error("Another sudo command is already running");
			if (!ctx.hasUI) throw new Error("sudo requires interactive user approval");
			if (signal?.aborted) throw abortError();
			const approved = await ctx.ui.confirm("Allow sudo command?", params.command);
			if (signal?.aborted) throw abortError();
			if (!approved) return { content: [{ type: "text", text: "denied by user" }], details: {} };
			if (!password) {
				password = await promptPassword(ctx);
				if (signal?.aborted) {
					lock();
					throw abortError();
				}
				if (!password) return { content: [{ type: "text", text: "cancelled by user" }], details: {} };
			}
			if (signal?.aborted) throw abortError();
			running = true;
			setStatus();
			try {
				const result = await runSudo(params.command, ctx.cwd, password, signal, (handle) => {
					activeHandle = handle;
				});
				const authFailed = /(?:incorrect password|authentication failure|no password was provided)/iu.test(
					result.output,
				);
				if (authFailed) lock();
				const suffix = result.fullOutputPath ? `\nFull output: ${result.fullOutputPath}` : "";
				return {
					content: [
						{
							type: "text",
							text: `exit ${result.exitCode ?? "signal"}${result.output ? `\n${result.output}` : ""}${suffix}`,
						},
					],
					details: { exitCode: result.exitCode, fullOutputPath: result.fullOutputPath },
				};
			} finally {
				activeHandle = undefined;
				running = false;
				setStatus();
			}
		},
	});
}
