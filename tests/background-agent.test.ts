import { describe, expect, it } from "vitest";
import { ownsRun, snapshotRun, truncateUtf8 } from "../extensions/subagent/index.js";

describe("background agent handoff truncation", () => {
	it("leaves bounded output unchanged", () => {
		expect(truncateUtf8("concise", 16)).toBe("concise");
	});

	it("strictly caps UTF-8 output and reports omitted bytes", () => {
		const output = truncateUtf8("😀".repeat(100), 80);
		expect(output).not.toContain("�");
		expect(output).toContain("bytes omitted]");
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(80);
	});

	it("caps the complete status envelope", () => {
		const output = truncateUtf8(`agent: scout\nstatus: complete\n\n${"x".repeat(500)}`, 96);
		expect(output).toMatch(/^agent: scout\nstatus: complete/);
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(96);
	});

	it("bounds persisted task and output", () => {
		const snapshot = snapshotRun({
			id: "abcd1234",
			agent: "scout",
			task: "t".repeat(10_000),
			cwd: "/tmp",
			status: "complete",
			delivery: "pending",
			startedAt: 1,
			finishedAt: 2,
			output: "o".repeat(20_000),
			generation: 1,
		});
		expect(Buffer.byteLength(snapshot.task ?? "")).toBeLessThanOrEqual(4 * 1024);
		expect(Buffer.byteLength(snapshot.output ?? "")).toBeLessThanOrEqual(12 * 1024);
	});

	it("persists delivered transitions without duplicating payloads", () => {
		const snapshot = snapshotRun(
			{
				id: "abcd1234",
				agent: "reviewer",
				task: "review",
				cwd: "/repo",
				status: "complete",
				delivery: "delivered",
				startedAt: 1,
				finishedAt: 2,
				output: "large result",
				generation: 1,
			},
			true,
		);
		expect(snapshot).toEqual({ id: "abcd1234", status: "complete", delivery: "delivered", finishedAt: 2 });
	});

	it("rejects stale settlement callbacks after branch generation changes", () => {
		const run = {
			id: "abcd1234",
			agent: "worker",
			task: "work",
			cwd: "/repo",
			status: "running" as const,
			delivery: "none" as const,
			startedAt: 1,
			generation: 3,
		};
		const runs = new Map([[run.id, run]]);
		expect(ownsRun(runs, run, 3)).toBe(true);
		expect(ownsRun(runs, run, 4)).toBe(false);
		runs.clear();
		expect(ownsRun(runs, run, 3)).toBe(false);
	});
});
