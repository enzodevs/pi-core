import { describe, expect, it } from "vitest";
import {
	type ManagedRun,
	normalizePersistedRun,
	ownsRun,
	resolveRequestedModel,
	snapshotRun,
	truncateUtf8,
} from "../extensions/subagent/index.js";

function managedRun(overrides: Partial<ManagedRun> = {}): ManagedRun {
	return {
		id: "abcd1234",
		agent: "worker",
		task: "work",
		cwd: "/repo",
		status: "running",
		activity: "running",
		delivery: "none",
		startedAt: 1,
		parentRunId: null,
		rootRunId: "abcd1234",
		depth: 1,
		ancestry: ["abcd1234"],
		generation: 1,
		...overrides,
	};
}

describe("background agent model selection", () => {
	const available = [
		{ provider: "openai", id: "gpt-5.6-terra" },
		{ provider: "openrouter", id: "anthropic/claude-sonnet" },
	];

	it("validates and preserves provider/model selections", () => {
		expect(resolveRequestedModel("openai/gpt-5.6-terra", available)).toBe("openai/gpt-5.6-terra");
		expect(resolveRequestedModel("openrouter/anthropic/claude-sonnet", available)).toBe(
			"openrouter/anthropic/claude-sonnet",
		);
		expect(resolveRequestedModel(undefined, available)).toBeUndefined();
	});

	it("rejects malformed, unknown, and unavailable models concisely", () => {
		expect(() => resolveRequestedModel("gpt-5.6-terra", available)).toThrow("expected provider/model");
		expect(() => resolveRequestedModel("openai/unknown", available)).toThrow("Unknown or unavailable model");
	});
});

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
		const output = truncateUtf8(`agent: worker\nstatus: complete\n\n${"x".repeat(500)}`, 96);
		expect(output).toMatch(/^agent: worker\nstatus: complete/);
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(96);
	});

	it("bounds persisted task and output", () => {
		const snapshot = snapshotRun(
			managedRun({
				task: "t".repeat(10_000),
				cwd: "/tmp",
				status: "complete",
				delivery: "pending",
				finishedAt: 2,
				output: "o".repeat(20_000),
			}),
		);
		expect(Buffer.byteLength(snapshot.task ?? "")).toBeLessThanOrEqual(8 * 1024);
		expect(Buffer.byteLength(snapshot.output ?? "")).toBeLessThanOrEqual(12 * 1024);
	});

	it("migrates prior top-level persistence into validated ownership", () => {
		expect(
			normalizePersistedRun({
				id: "abcd1234",
				agent: "worker",
				task: "legacy task",
				cwd: "/repo",
				status: "running",
				delivery: "none",
				startedAt: 1,
			}),
		).toMatchObject({
			parentRunId: null,
			rootRunId: "abcd1234",
			depth: 1,
			ancestry: ["abcd1234"],
		});
	});

	it("round-trips a live tmux runtime for reload reattachment", () => {
		const runtime = {
			backend: "tmux-tui" as const,
			sessionFile: "/tmp/child.jsonl",
			paneId: "%9",
			channelDirectory: "/tmp/channel",
			channelToken: "token",
		};
		const snapshot = snapshotRun(managedRun({ runtime }));

		expect(normalizePersistedRun(snapshot)).toMatchObject({ runtime });
	});

	it("persists delivered transitions without duplicating payloads", () => {
		const snapshot = snapshotRun(
			managedRun({
				agent: "reviewer",
				task: "review",
				status: "complete",
				delivery: "delivered",
				finishedAt: 2,
				output: "large result",
			}),
			true,
		);
		expect(snapshot).toEqual({ id: "abcd1234", status: "complete", delivery: "delivered", finishedAt: 2 });
	});

	it("rejects stale settlement callbacks after branch generation changes", () => {
		const run = managedRun({ generation: 3 });
		const runs = new Map([[run.id, run]]);
		expect(ownsRun(runs, run, 3)).toBe(true);
		expect(ownsRun(runs, run, 4)).toBe(false);
		runs.clear();
		expect(ownsRun(runs, run, 3)).toBe(false);
	});
});
