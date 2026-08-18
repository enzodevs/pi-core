import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	boundedMonitorTail,
	type MonitorRun,
	ownsMonitor,
	runMonitorCommand,
	snapshotMonitor,
} from "../extensions/monitor/index.js";

function runningRun(): MonitorRun {
	return {
		id: "abcd1234",
		command: "sleep 10",
		cwd: "/tmp",
		status: "running",
		delivery: "none",
		startedAt: 1,
		generation: 2,
	};
}

describe("background monitor", () => {
	it("bounds output by lines and UTF-8 bytes", () => {
		const output = boundedMonitorTail(
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
		expect(snapshotMonitor(run, true)).toEqual({
			id: "abcd1234",
			status: "complete",
			delivery: "delivered",
			finishedAt: 3,
			exitCode: 0,
		});
	});

	it("rejects callbacks after branch ownership changes", () => {
		const run = runningRun();
		const runs = new Map([[run.id, run]]);
		expect(ownsMonitor(runs, run, 2)).toBe(true);
		expect(ownsMonitor(runs, run, 3)).toBe(false);
		runs.clear();
		expect(ownsMonitor(runs, run, 2)).toBe(false);
	});

	it("captures combined output and exit status outside model context", async () => {
		const result = await runMonitorCommand("printf out; printf err >&2", "/tmp", 5, () => {});
		expect(result.status).toBe("complete");
		expect(result.exitCode).toBe(0);
		expect(result.output).toContain("out");
		expect(result.output).toContain("err");
		expect(await readFile(result.fullOutputPath, "utf8")).toContain("out");
	});

	it("terminates a timed-out process group", async () => {
		const result = await runMonitorCommand("sleep 10", "/tmp", 1, () => {});
		expect(result.status).toBe("timed_out");
		expect(result.exitCode).not.toBe(0);
	});

	it("reports explicit cancellation as stopped", async () => {
		const result = await runMonitorCommand("sleep 10", "/tmp", undefined, (handle) => {
			setTimeout(() => handle.stop(), 20);
		});
		expect(result.status).toBe("stopped");
		expect(result.exitCode).not.toBe(0);
	});
});
