import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	type BackgroundProcessRun,
	detailedProcessStatus,
	ownsProcess,
	processCompletionText,
	snapshotProcess,
} from "../extensions/background-process/index.js";
import { PROCESS_LOG_RESULT_BYTES, ProcessLogStore } from "../extensions/background-process/log-store.js";
import { boundedProcessTail, runBackgroundProcess } from "../extensions/background-process/process.js";

const roots: string[] = [];

function root(): string {
	const value = fs.mkdtempSync(path.join(os.tmpdir(), "pi-background-process-test-"));
	roots.push(value);
	return value;
}

function runningRun(): BackgroundProcessRun {
	return {
		id: "abcd1234",
		command: "sleep 10",
		cwd: "/tmp",
		mode: "wait",
		status: "running",
		delivery: "none",
		startedAt: 1,
		logBytes: 0,
		generation: 2,
	};
}

async function run(command: string, mode: "wait" | "service" = "wait", timeoutSeconds = 5) {
	const store = new ProcessLogStore({ root: root() });
	const log = store.create("1234abcd");
	return runBackgroundProcess({ command, cwd: "/tmp", mode, timeoutSeconds, log, onSpawn() {} });
}

afterEach(() => {
	for (const value of roots.splice(0)) fs.rmSync(value, { recursive: true, force: true });
});

describe("background process", () => {
	it("bounds output by lines and UTF-8 bytes", () => {
		const output = boundedProcessTail(
			Array.from({ length: 800 }, (_, index) => `${index} ${"x".repeat(40)}`).join("\n"),
		);
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(12 * 1024);
		expect(output).toContain("truncated");
		expect(output).toContain("799 ");
	});

	it("persists delivered transitions without command or output duplication", () => {
		const run = {
			...runningRun(),
			status: "complete" as const,
			delivery: "delivered" as const,
			finishedAt: 3,
			exitCode: 0,
			output: "large output",
		};
		expect(snapshotProcess(run, true)).toEqual({
			id: "abcd1234",
			status: "complete",
			delivery: "delivered",
			finishedAt: 3,
			exitCode: 0,
		});
	});

	it("rejects callbacks after branch ownership changes", () => {
		const process = runningRun();
		const runs = new Map([[process.id, process]]);
		expect(ownsProcess(runs, process, 2)).toBe(true);
		expect(ownsProcess(runs, process, 3)).toBe(false);
		runs.clear();
		expect(ownsProcess(runs, process, 2)).toBe(false);
	});

	it("captures combined output and finite exit status", async () => {
		const result = await run("printf out; printf err >&2");
		expect(result.status).toBe("complete");
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
	});

	it("treats an unrequested service exit as failure even with code zero", async () => {
		const result = await run("printf ready", "service");
		expect(result.status).toBe("failed");
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("ready");
	});

	it("preserves completion metadata when captured output is truncated", async () => {
		const result = await run("for i in $(seq 1 1500); do printf 'stress-line-%04d %080d\\n' \"$i\" 0; done");
		const text = processCompletionText({
			...runningRun(),
			status: "complete",
			delivery: "pending",
			exitCode: 0,
			output: result.output,
		});

		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4 * 1024);
		expect(text).toMatch(/^process: abcd1234\nmode: wait\nstatus: complete\nexit: 0/);
		expect(text).toContain("use process_control search");
		expect(text).toContain("stress-line-1500");
	});

	it("starts a truncated Unicode tail without replacement characters", () => {
		const output = Array.from({ length: 1200 }, (_, index) => `λ-${index + 1} 😀 漢字 café 🚀`).join("\n");
		const text = processCompletionText({
			...runningRun(),
			status: "complete",
			delivery: "pending",
			exitCode: 0,
			output,
		});
		expect(text).not.toContain("�");
	});

	it("terminates a timed-out process group", async () => {
		const result = await run("sleep 10", "wait", 1);
		expect(result.status).toBe("timed_out");
		expect(result.exitCode).not.toBe(0);
	});

	it("reports explicit cancellation as stopped", async () => {
		const store = new ProcessLogStore({ root: root() });
		const log = store.create("1234abcd");
		const result = await runBackgroundProcess({
			command: "sleep 10",
			cwd: "/tmp",
			mode: "service",
			log,
			onSpawn(handle) {
				setTimeout(() => handle.stop(), 20);
			},
		});
		expect(result.status).toBe("stopped");
		expect(result.exitCode).not.toBe(0);
	});

	it("force-kills stubborn descendants without retaining a stale group timer", async () => {
		const store = new ProcessLogStore({ root: root() });
		const log = store.create("1234abcd");
		const result = await runBackgroundProcess({
			command: `sh -c 'trap "" TERM; sleep 30' & echo CHILD_PID=$!; wait`,
			cwd: "/tmp",
			mode: "service",
			log,
			onSpawn(handle) {
				setTimeout(() => handle.stop(), 50);
			},
		});
		const pid = Number.parseInt(result.output.match(/CHILD_PID=(\d+)/u)?.[1] ?? "", 10);

		expect(result.status).toBe("stopped");
		expect(pid).toBeGreaterThan(0);
		expect(() => process.kill(pid, 0)).toThrow();
	});

	it("searches logs while a service is still running", async () => {
		const store = new ProcessLogStore({ root: root() });
		const log = store.create("1234abcd");
		let stop: (() => void) | undefined;
		const completion = runBackgroundProcess({
			command: "printf 'server ready\\n'; sleep 10",
			cwd: "/tmp",
			mode: "service",
			log,
			onSpawn(handle) {
				stop = handle.stop;
			},
		});
		await new Promise((resolve) => setTimeout(resolve, 40));

		expect(log.search("server ready").matches).toBe(1);
		stop?.();
		expect((await completion).status).toBe("stopped");
	});

	it("rotates private logs within two segments and searches retained lines", () => {
		const directory = root();
		const store = new ProcessLogStore({ root: directory, segmentBytes: 1024 });
		const log = store.create("abcdef12");
		log.append(Buffer.from(`${"a".repeat(900)}\nTARGET failure code 7391\n${"b".repeat(900)}\n`));
		log.close();
		const result = log.search("TARGET 7391");
		const retained = fs
			.readdirSync(directory)
			.map((file) => fs.statSync(path.join(directory, file)).size)
			.reduce((total, size) => total + size, 0);

		expect(result.matches).toBe(1);
		expect(result.text).toContain("TARGET failure code 7391");
		expect(retained).toBeLessThanOrEqual(2048);
		expect(fs.statSync(path.join(directory, "abcdef12.log")).mode & 0o777).toBe(0o600);
		expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
	});

	it("requires every lexical term on the same matching line", () => {
		const store = new ProcessLogStore({ root: root() });
		const log = store.create("abcdef12");
		log.append(Buffer.from("TARGET appears alone\n7391 appears elsewhere\n"));

		expect(log.search("TARGET 7391").matches).toBe(0);
	});

	it("centers byte-bounded search output around a match in a huge line", () => {
		const store = new ProcessLogStore({ root: root(), segmentBytes: 32_000 });
		const log = store.create("abcdef12");
		log.append(Buffer.from(`${"x".repeat(12_000)}UNIQUE_NEEDLE${"y".repeat(12_000)}`));
		const result = log.search("UNIQUE_NEEDLE");

		expect(result.text).toContain("UNIQUE_NEEDLE");
		expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(PROCESS_LOG_RESULT_BYTES);
	});

	it("removes logs after their retention period", () => {
		const directory = root();
		let now = 1_000;
		const store = new ProcessLogStore({ root: directory, ttlMs: 100, now: () => now });
		const log = store.create("abcdef12");
		log.append(Buffer.from("retained"));
		log.close();
		const logPath = path.join(directory, "abcdef12.log");
		fs.utimesSync(logPath, new Date(0), new Date(0));
		now += 200;
		store.cleanup();

		expect(fs.existsSync(logPath)).toBe(false);
	});

	it("shows command and process purpose in detailed status", () => {
		const text = detailedProcessStatus({ ...runningRun(), mode: "service", command: "npm run dev" }, false);
		expect(text).toContain("abcd1234 service running");
		expect(text).toContain("command: npm run dev");
	});
});
