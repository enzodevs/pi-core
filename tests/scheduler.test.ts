import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type CheckResult, nextTime, Scheduler, type Spec } from "../extensions/scheduler/core.js";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function harness() {
	const root = mkdtempSync(join(tmpdir(), "pi-scheduler-"));
	roots.push(root);
	const file = join(root, "jobs.json");
	let now = Date.parse("2026-06-01T00:00:00Z");
	let idle = true;
	const run = vi.fn(
		async (): Promise<CheckResult> => ({ status: "complete", exitCode: 0, output: "ok", logPath: "/log" }),
	);
	const deliver = vi.fn();
	const stop = vi.fn();
	const io = { now: () => now, idle: () => idle, run, deliver, stop };
	let scheduler = new Scheduler(file, io);
	return {
		root,
		file,
		run,
		deliver,
		stop,
		get scheduler() {
			return scheduler;
		},
		advance(ms = 30000) {
			now += ms;
		},
		idle(value: boolean) {
			idle = value;
		},
		create(spec: Partial<Spec> = {}) {
			return JSON.parse(scheduler.create({ when: "+30s", prompt: "check deployment", ...spec }, root))
				.id as string;
		},
		job(id: string) {
			return JSON.parse(scheduler.describe(id));
		},
		restart() {
			scheduler.close();
			scheduler = new Scheduler(file, io);
		},
	};
}

describe("scheduler timing", () => {
	const now = Date.parse("2026-06-01T00:00:00Z");
	it("supports once, fixed delay, zoned ISO and five-field UTC cron", () => {
		expect(nextTime({ when: "+5m", prompt: "x" }, now)).toBe(now + 300000);
		expect(nextTime({ when: "+5m", prompt: "x" }, now, true)).toBeUndefined();
		expect(nextTime({ when: "every 5m", prompt: "x" }, now, true)).toBe(now + 300000);
		expect(nextTime({ when: "2026-06-01T09:00:00-03:00", prompt: "x" }, now)).toBe(now + 43200000);
		expect(nextTime({ when: "0 9 * * *", prompt: "x" }, now)).toBe(now + 32400000);
		expect(nextTime({ when: "0 9 * * *", timezone: "America/Sao_Paulo", prompt: "x" }, now)).toBe(
			now + 43200000,
		);
	});
	it("rejects ambiguous and too-fast inputs", () => {
		for (const when of [
			"tomorrow",
			"+1s",
			"every 0m",
			"* * * * * *",
			"2026-06-01T09:00:00",
			"every 9999999999999999999d",
		])
			expect(() => nextTime({ when, prompt: "x" }, now)).toThrow();
	});
});

describe("scheduler core", () => {
	it("executes +1d and distant one-shots with a full recovery window after due time", async () => {
		const h = harness();
		const id = h.create({ when: "+1d" });
		const later = h.create({ when: "2026-06-04T00:00:00Z" });
		expect(h.job(id).expires - h.job(id).next).toBe(86400000);
		h.advance(86400001);
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.deliver).toHaveBeenCalledExactlyOnceWith(expect.any(String), id);
		h.advance(2 * 86400000);
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.deliver).toHaveBeenLastCalledWith(expect.any(String), later);
	});
	it("rejects an explicit expiry at the first due slot and preserves recurring lifetime", () => {
		const h = harness();
		expect(() => h.create({ when: "+1d", expiresAt: "2026-06-02T00:00:00Z" })).toThrow("No future execution");
		const id = h.create({ when: "every 30s" });
		expect(h.job(id).expires).toBe(Date.parse("2026-06-02T00:00:00Z"));
	});
	it("delivers independent reminders while a shell is running, but serializes other shells", async () => {
		const h = harness();
		h.create({ command: "first", wake: "always" });
		const reminder = h.create();
		h.create({ command: "second", wake: "never" });
		let finish!: (value: CheckResult) => void;
		h.run.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		h.advance();
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.run).toHaveBeenCalledTimes(1);
		expect(h.deliver).toHaveBeenCalledExactlyOnceWith(expect.any(String), reminder);
		finish({ status: "complete", exitCode: 0, output: "ok", logPath: "/log" });
		await Promise.resolve();
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.run).toHaveBeenCalledTimes(2);
	});
	it("fails closed when saving an asynchronous shell completion fails", async () => {
		const h = harness();
		h.create({ command: "check" });
		let finish!: (value: CheckResult) => void;
		h.run.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		h.advance();
		await h.scheduler.tick();
		rmSync(h.file);
		mkdirSync(h.file);
		finish({ status: "complete", exitCode: 0, output: "ok", logPath: "/log" });
		await Promise.resolve();
		await expect(h.scheduler.tick()).rejects.toThrow();
		expect(h.deliver).not.toHaveBeenCalled();
	});
	it("does not execute side effects if persisting the claim fails", async () => {
		const h = harness();
		h.create({ command: "test" });
		rmSync(h.file);
		mkdirSync(h.file);
		h.advance();
		await expect(h.scheduler.tick()).rejects.toThrow();
		expect(h.run).not.toHaveBeenCalled();
		await h.scheduler.tick();
		expect(h.run).not.toHaveBeenCalled();
	});
	it("suppresses late shell results after closing the owning session", async () => {
		const h = harness();
		const id = h.create({ command: "test", wake: "always" });
		let finish!: (value: CheckResult) => void;
		h.run.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		h.advance();
		const pending = h.scheduler.tick();
		h.scheduler.close();
		expect(h.stop).toHaveBeenCalledWith(id);
		finish({ status: "complete", exitCode: 0, output: "late", logPath: "/log" });
		await pending;
		expect(h.deliver).not.toHaveBeenCalled();
		expect(JSON.parse(readFileSync(h.file, "utf8")).jobs[0].status).toBe("running");
	});
	it("persists one-shot prompts and delivers only once when idle", async () => {
		const h = harness();
		const id = h.create();
		h.idle(false);
		h.advance();
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.deliver).not.toHaveBeenCalled();
		expect(h.job(id).status).toBe("done");
		h.restart();
		h.idle(true);
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.deliver).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("check deployment"), id);
		expect(h.run).not.toHaveBeenCalled();
	});
	it("coalesces missed intervals and enforces execution cap", async () => {
		const h = harness();
		const id = h.create({ when: "every 30s", maxRuns: 2 });
		h.advance(3600000);
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.job(id).runs).toBe(1);
		h.advance();
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.job(id).status).toBe("done");
		expect(h.deliver).toHaveBeenCalledTimes(2);
	});
	it("defaults shell checks to wake on failure, treating timeouts as failures", async () => {
		const h = harness();
		const id = h.create({ when: "every 30s", command: "test" });
		h.advance();
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.deliver).not.toHaveBeenCalled();
		h.run.mockResolvedValue({ status: "timed_out", exitCode: null, output: "error", logPath: "/log" });
		h.advance();
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.deliver).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("timed_out exit=null"), id);
	});
	it.each(["always", "success", "never"] as const)("supports %s wake policy", async (wake) => {
		const h = harness();
		h.create({ command: "test", wake });
		h.advance();
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.deliver).toHaveBeenCalledTimes(wake === "never" ? 0 : 1);
	});
	it("change establishes a quiet baseline and wakes only on a changed result", async () => {
		const h = harness();
		h.create({ when: "every 30s", command: "test", wake: "change" });
		for (let i = 0; i < 2; i++) {
			h.advance();
			await h.scheduler.tick();
		}
		expect(h.deliver).not.toHaveBeenCalled();
		h.run.mockResolvedValue({ status: "complete", exitCode: 0, output: "changed", logPath: "/log" });
		h.advance();
		await h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.deliver).toHaveBeenCalledTimes(1);
	});
	it("does not overlap ticks; pause cancels a running shell and suppresses its result", async () => {
		const h = harness();
		const id = h.create({ command: "test", wake: "always" });
		let finish!: (value: CheckResult) => void;
		h.run.mockImplementation(
			() =>
				new Promise((resolve) => {
					finish = resolve;
				}),
		);
		h.advance();
		const pending = h.scheduler.tick();
		await h.scheduler.tick();
		expect(h.run).toHaveBeenCalledTimes(1);
		h.scheduler.control("pause", id);
		expect(h.stop).toHaveBeenCalledWith(id);
		finish({ status: "complete", exitCode: 0, output: "late", logPath: "/log" });
		await pending;
		await h.scheduler.tick();
		expect(h.deliver).not.toHaveBeenCalled();
		expect(h.job(id).status).toBe("paused");
	});
	it("pauses interrupted claims instead of replaying side effects on restart", async () => {
		const h = harness();
		const id = h.create({ command: "test" });
		const state = JSON.parse(readFileSync(h.file, "utf8"));
		state.jobs[0].status = "running";
		writeFileSync(h.file, JSON.stringify(state));
		h.restart();
		h.advance();
		await h.scheduler.tick();
		expect(h.run).not.toHaveBeenCalled();
		expect(h.job(id).status).toBe("paused");
		h.scheduler.control("resume", id);
		await h.scheduler.tick();
		expect(h.run).toHaveBeenCalledTimes(1);
	});
	it("stops at expiry, supports remove, rejects invalid parameters and missing IDs", async () => {
		const h = harness();
		const id = h.create();
		h.advance(86430001);
		await h.scheduler.tick();
		expect(h.job(id).status).toBe("done");
		expect(h.deliver).not.toHaveBeenCalled();
		expect(() => h.scheduler.control("resume", id)).toThrow();
		h.scheduler.control("remove", id);
		expect(h.scheduler.describe()).toBe("0 jobs");
		expect(() => h.scheduler.control("pause", id)).toThrow();
		expect(() => h.create({ wake: "always" })).toThrow();
		expect(() => h.create({ when: "+2d", expiresAt: "2026-06-02T00:00:00Z" })).toThrow();
		expect(() => h.create({ timezone: "invalid/zone" })).toThrow();
	});
	it("fails closed on malformed persisted state without replacing it", () => {
		const h = harness();
		writeFileSync(h.file, '{"version":2}');
		expect(() => h.restart()).toThrow("Invalid scheduler state");
		expect(readFileSync(h.file, "utf8")).toBe('{"version":2}');
	});
	it("bounds jobs and inspection; retains pending delivery after a failed handoff", async () => {
		const h = harness();
		for (let i = 0; i < 32; i++) h.create();
		expect(() => h.create()).toThrow("32 jobs");
		h.advance();
		await h.scheduler.tick();
		h.deliver.mockImplementationOnce(() => {
			throw new Error("delivery failed");
		});
		await expect(h.scheduler.tick()).rejects.toThrow("delivery failed");
		h.restart();
		await h.scheduler.tick();
		expect(h.deliver).toHaveBeenCalledTimes(2);
		expect(Buffer.byteLength(h.scheduler.describe())).toBeLessThan(12000);
	});
});
