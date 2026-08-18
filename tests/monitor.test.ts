import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
	boundedMonitorTail,
	type MonitorRun,
	monitorCompletionText,
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

	it("preserves completion metadata when captured output is truncated", async () => {
		const result = await runMonitorCommand(
			"for i in $(seq 1 1500); do printf 'stress-line-%04d %080d\\n' \"$i\" 0; done",
			"/tmp",
			5,
			() => {},
		);
		const text = monitorCompletionText({
			...runningRun(),
			status: "complete",
			delivery: "pending",
			exitCode: 0,
			output: result.output,
			fullOutputPath: result.fullOutputPath,
		});

		expect(Buffer.byteLength(text)).toBeLessThanOrEqual(4 * 1024);
		expect(text).toMatch(/^monitor: abcd1234\nstatus: complete\nexit: 0\nfull: \/tmp\/pi-monitor-/);
		expect(text).toContain("[truncated:");
		expect(text).toContain("stress-line-1500");
		expect(text).toMatch(/\[truncated: showing output tail\]\nstress-line-/);
		expect(text).not.toContain("]]ne-");
	});

	it("starts a truncated Unicode tail on a complete line", () => {
		const output = Array.from({ length: 1200 }, (_, index) => `λ-${index + 1} 😀 漢字 café 🚀`).join("\n");
		const text = monitorCompletionText({
			...runningRun(),
			status: "complete",
			delivery: "pending",
			exitCode: 0,
			output,
		});
		const tail = text.split("[truncated: showing output tail]\n")[1];

		expect(tail).toMatch(/^λ-\d+ 😀/u);
		expect(tail).not.toContain("�");
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
