#!/usr/bin/env node

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { StringDecoder } from "node:string_decoder";

const DEFAULT_PROMPTS = [
	"Reply with exactly: benchmark complete",
	"What is 17 multiplied by 23? Reply with only the number.",
	"Name the capital of Japan. Reply with only the city name.",
];
const STATE_PATH = join(homedir(), ".pi", "agent", "pi-core", "fast-mode.json");
const SIGNAL_EXIT_CODES = { SIGINT: 130, SIGTERM: 143 };

function usage() {
	console.log(`Usage: npm run benchmark:fast -- --model <model> [options]

Options:
  --model <id>        OpenAI Codex model ID (required)
  --runs <number>     Samples per mode (default: 10)
  --prompt <text>     Add a prompt; repeat for multiple prompts
  --output <path>     JSON result path (default: fast-mode-benchmark-<time>.json)
  --pi <path>         Pi executable (default: pi)
  --help              Show this help

One persistent Pi RPC process is warmed once, then runs a randomized, balanced
Fast ON/OFF schedule. Do not change /fast or run another benchmark concurrently.`);
}

function parseArgs(argv) {
	const options = { model: undefined, output: undefined, pi: "pi", prompts: [], runs: 10 };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--help") return { ...options, help: true };
		if (!["--model", "--runs", "--prompt", "--output", "--pi"].includes(argument)) {
			throw new Error(`Unknown option: ${argument}`);
		}
		const value = argv[index + 1];
		if (!value) throw new Error(`Missing value for ${argument}`);
		if (argument === "--model") options.model = value;
		else if (argument === "--runs") options.runs = Number(value);
		else if (argument === "--prompt") options.prompts.push(value);
		else if (argument === "--output") options.output = value;
		else options.pi = value;
		index += 1;
	}
	if (!options.model) throw new Error("--model is required");
	if (!Number.isInteger(options.runs) || options.runs < 1) {
		throw new Error("--runs must be a positive integer");
	}
	if (options.prompts.length === 0) options.prompts = [...DEFAULT_PROMPTS];
	return options;
}

function shuffle(values) {
	for (let index = values.length - 1; index > 0; index -= 1) {
		const other = Math.floor(Math.random() * (index + 1));
		[values[index], values[other]] = [values[other], values[index]];
	}
	return values;
}

function percentile(values, fraction) {
	const sorted = [...values].sort((left, right) => left - right);
	const position = (sorted.length - 1) * fraction;
	const lower = Math.floor(position);
	const upper = Math.ceil(position);
	return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

function summarize(samples) {
	const firstTextDeltaMs = samples.map((sample) => sample.firstTextDeltaMs);
	const agentEndMs = samples.map((sample) => sample.agentEndMs);
	return {
		samples: samples.length,
		medianFirstTextDeltaMs: percentile(firstTextDeltaMs, 0.5),
		p95FirstTextDeltaMs: percentile(firstTextDeltaMs, 0.95),
		medianAgentEndMs: percentile(agentEndMs, 0.5),
		p95AgentEndMs: percentile(agentEndMs, 0.95),
	};
}

function improvementPercent(baseline, fast) {
	return ((baseline - fast) / baseline) * 100;
}

class RpcClient {
	constructor(executable, args) {
		this.child = spawn(executable, args, { stdio: ["pipe", "pipe", "pipe"] });
		this.decoder = new StringDecoder("utf8");
		this.buffer = "";
		this.stderr = "";
		this.nextId = 0;
		this.pending = new Map();
		this.activePrompt = undefined;
		this.closing = false;
		this.closed = new Promise((resolveClosed) => {
			this.resolveClosed = resolveClosed;
		});
		this.child.stdout.on("data", (chunk) => this.consume(chunk));
		this.child.stderr.on("data", (chunk) => {
			this.stderr = `${this.stderr}${chunk}`.slice(-16_384);
		});
		this.child.on("error", (error) => this.fail(error));
		this.child.on("close", (code, signal) => {
			this.resolveClosed();
			if (!this.closing) {
				const detail = this.stderr.trim();
				this.fail(
					new Error(`Pi RPC exited unexpectedly (${signal ?? `code ${code}`})${detail ? `: ${detail}` : ""}`),
				);
			}
		});
	}

	consume(chunk) {
		this.buffer += this.decoder.write(chunk);
		for (let newline = this.buffer.indexOf("\n"); newline !== -1; newline = this.buffer.indexOf("\n")) {
			let line = this.buffer.slice(0, newline);
			this.buffer = this.buffer.slice(newline + 1);
			if (line.endsWith("\r")) line = line.slice(0, -1);
			if (!line) continue;
			try {
				this.handle(JSON.parse(line));
			} catch (error) {
				this.fail(new Error(`Invalid Pi RPC JSON: ${line}`, { cause: error }));
			}
		}
	}

	handle(record) {
		if (record.type === "response" && record.id && this.pending.has(record.id)) {
			const { reject, resolve: resolveResponse } = this.pending.get(record.id);
			this.pending.delete(record.id);
			if (record.success) resolveResponse(record);
			else reject(new Error(`Pi RPC ${record.command} failed: ${record.error ?? "unknown error"}`));
		}

		const active = this.activePrompt;
		if (!active || record.type === "response") return;
		active.events.push(record);
		if (
			active.firstTextDeltaAt === undefined &&
			record.type === "message_update" &&
			record.assistantMessageEvent?.type === "text_delta"
		) {
			active.firstTextDeltaAt = performance.now();
		}
		if (record.type === "agent_end") {
			this.activePrompt = undefined;
			if (active.firstTextDeltaAt === undefined) {
				active.reject(new Error("Agent ended without an assistant text_delta event"));
				return;
			}
			active.resolve({
				firstTextDeltaMs: active.firstTextDeltaAt - active.startedAt,
				agentEndMs: performance.now() - active.startedAt,
				events: active.events,
			});
		}
	}

	fail(error) {
		for (const pending of this.pending.values()) pending.reject(error);
		this.pending.clear();
		if (this.activePrompt) {
			this.activePrompt.reject(error);
			this.activePrompt = undefined;
		}
	}

	write(command, beforeWrite) {
		if (this.closing || !this.child.stdin.writable) {
			throw new Error("Pi RPC stdin is not writable");
		}
		const line = `${JSON.stringify(command)}\n`;
		beforeWrite?.();
		this.child.stdin.write(line);
	}

	request(command) {
		const id = `benchmark-${++this.nextId}`;
		const response = new Promise((resolveResponse, reject) => {
			this.pending.set(id, { reject, resolve: resolveResponse });
		});
		try {
			this.write({ id, ...command });
		} catch (error) {
			this.pending.delete(id);
			throw error;
		}
		return response;
	}

	async measurePrompt(message) {
		if (this.activePrompt) throw new Error("Cannot overlap measured RPC prompts");
		let resolvePrompt;
		let rejectPrompt;
		const completed = new Promise((resolveCompleted, reject) => {
			resolvePrompt = resolveCompleted;
			rejectPrompt = reject;
		});
		const id = `benchmark-${++this.nextId}`;
		const response = new Promise((resolveResponse, reject) => {
			this.pending.set(id, { reject, resolve: resolveResponse });
		});
		const command = { id, type: "prompt", message };
		const active = {
			events: [],
			firstTextDeltaAt: undefined,
			reject: rejectPrompt,
			resolve: resolvePrompt,
			startedAt: undefined,
		};
		this.activePrompt = active;
		try {
			this.write(command, () => {
				active.startedAt = performance.now();
			});
			const [, result] = await Promise.all([response, completed]);
			return result;
		} catch (error) {
			this.pending.delete(id);
			if (this.activePrompt === active) this.activePrompt = undefined;
			throw error;
		}
	}

	async close() {
		if (this.closing) return this.closed;
		this.closing = true;
		this.child.stdin.end();
		this.child.kill("SIGTERM");
		const forceKill = setTimeout(() => this.child.kill("SIGKILL"), 2_000);
		forceKill.unref();
		await this.closed;
		clearTimeout(forceKill);
	}
}

async function snapshotState(path) {
	try {
		const [data, metadata] = await Promise.all([readFile(path), stat(path)]);
		return { data, exists: true, mode: metadata.mode & 0o777 };
	} catch (error) {
		if (error.code === "ENOENT") return { exists: false };
		throw error;
	}
}

async function restoreState(path, snapshot) {
	if (!snapshot.exists) {
		await rm(path, { force: true });
		return;
	}
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
	try {
		await writeFile(temporaryPath, snapshot.data, { mode: snapshot.mode });
		await rename(temporaryPath, path);
	} finally {
		await rm(temporaryPath, { force: true });
	}
}

let client;
let originalState;
let cleanupPromise;
function cleanup() {
	if (!cleanupPromise) {
		cleanupPromise = (async () => {
			try {
				await client?.close();
			} finally {
				if (originalState) await restoreState(STATE_PATH, originalState);
			}
		})();
	}
	return cleanupPromise;
}

let caughtSignal;
for (const signal of Object.keys(SIGNAL_EXIT_CODES)) {
	process.once(signal, () => {
		caughtSignal = signal;
		void cleanup().then(
			() => process.exit(SIGNAL_EXIT_CODES[signal]),
			(error) => {
				console.error(`Cleanup after ${signal} failed:`, error);
				process.exit(1);
			},
		);
	});
}

async function main() {
	const options = parseArgs(process.argv.slice(2));
	if (options.help) {
		usage();
		return;
	}

	originalState = await snapshotState(STATE_PATH);
	client = new RpcClient(options.pi, [
		"--mode",
		"rpc",
		"--no-session",
		"--provider",
		"openai-codex",
		"--model",
		options.model,
		"--thinking",
		"low",
		"--tools",
		"",
	]);

	const commands = await client.request({ type: "get_commands" });
	const fastCommand = commands.data?.commands?.find(
		(command) => command.name === "fast" && command.source === "extension",
	);
	if (!fastCommand) {
		throw new Error("The /fast extension command is not loaded in the Pi RPC process");
	}

	console.log("Warming the persistent OpenAI Codex connection (excluded from results)...");
	await client.request({ type: "prompt", message: "/fast off" });
	const warmupSession = await client.request({ type: "new_session" });
	if (warmupSession.data?.cancelled) throw new Error("Warmup new_session was cancelled");
	const warmup = await client.measurePrompt(options.prompts[0]);

	const schedule = shuffle([
		...Array.from({ length: options.runs }, () => false),
		...Array.from({ length: options.runs }, () => true),
	]);
	const samples = [];
	console.log(
		`Running ${options.runs} samples per mode (${schedule.length} total) across ${options.prompts.length} prompts.`,
	);
	for (const [index, fast] of schedule.entries()) {
		const prompt = options.prompts[index % options.prompts.length];
		await client.request({ type: "prompt", message: `/fast ${fast ? "on" : "off"}` });
		const session = await client.request({ type: "new_session" });
		if (session.data?.cancelled) throw new Error(`new_session was cancelled before sample ${index + 1}`);
		const measured = await client.measurePrompt(prompt);
		const sample = { index: index + 1, fast, prompt, ...measured };
		samples.push(sample);
		console.log(
			`${String(index + 1).padStart(2)}/${schedule.length} ${fast ? "ON " : "OFF"} first=${measured.firstTextDeltaMs.toFixed(0)}ms end=${measured.agentEndMs.toFixed(0)}ms`,
		);
	}

	const off = summarize(samples.filter((sample) => !sample.fast));
	const on = summarize(samples.filter((sample) => sample.fast));
	const summary = { off, on };
	const improvement = {
		medianFirstTextDeltaPercent: improvementPercent(off.medianFirstTextDeltaMs, on.medianFirstTextDeltaMs),
		medianAgentEndPercent: improvementPercent(off.medianAgentEndMs, on.medianAgentEndMs),
	};
	const output = resolve(
		options.output ?? `fast-mode-benchmark-${new Date().toISOString().replaceAll(":", "-")}.json`,
	);
	await mkdir(dirname(output), { recursive: true });
	await writeFile(
		output,
		`${JSON.stringify(
			{
				configuration: {
					model: options.model,
					provider: "openai-codex",
					runsPerMode: options.runs,
					thinking: "low",
					tools: [],
					prompts: options.prompts,
				},
				warmup: { prompt: options.prompts[0], ...warmup },
				samples,
				summary,
				improvement,
			},
			null,
			2,
		)}\n`,
		"utf8",
	);

	console.table([
		{ mode: "OFF", ...off },
		{ mode: "ON", ...on },
	]);
	console.log(
		`Fast mode median improvement: first text ${improvement.medianFirstTextDeltaPercent.toFixed(1)}%, agent end ${improvement.medianAgentEndPercent.toFixed(1)}%`,
	);
	console.log(`Raw results and summaries: ${output}`);
}

try {
	await main();
} catch (error) {
	if (!caughtSignal) {
		console.error(error instanceof Error ? error.message : error);
		process.exitCode = 1;
	}
} finally {
	await cleanup();
}
