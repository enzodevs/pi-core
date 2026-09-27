import { afterEach, describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	delete process.env.PI_CORE_SUBAGENT_CONTEXT;
});

import * as profiles from "../extensions/subagent/agents.ts";
import backgroundAgents from "../extensions/subagent/index.ts";
import { GlobalConcurrencyRegistry } from "../extensions/subagent/registry.ts";
import * as runner from "../extensions/subagent/runner.ts";
import { WorktreeLifecycle, type WorktreeVerification } from "../extensions/subagent/worktree-lifecycle.ts";
import { WorktreeLedger } from "../extensions/subagent/worktree-reaper.ts";

afterEach(() => vi.restoreAllMocks());

const receipt: WorktreeVerification = {
	state: "passed",
	summary: "Checks passed",
	hooksHash: "c".repeat(64),
	workspace: {
		head: "a".repeat(40),
		branch: "pi-agent/worker-0123456789ab",
		repository: "/repo/.git",
		target: "main",
		targetHead: "b".repeat(40),
		targetCwd: "/repo",
	},
};

function storedRun(overrides: Record<string, unknown> = {}) {
	return {
		id: "0123456789ab",
		agent: "worker",
		task: "task",
		cwd: "/repo.worker",
		workspace: "worktree",
		status: "complete",
		activity: "running",
		delivery: "pending",
		startedAt: 1,
		finishedAt: 2,
		output: "Finished",
		parentRunId: null,
		rootRunId: "0123456789ab",
		depth: 1,
		ancestry: ["0123456789ab"],
		verification: receipt,
		...overrides,
	};
}

function harness(initial: ReturnType<typeof storedRun>[] = []) {
	const entries = initial.map((data) => ({ type: "custom", customType: "pi-core-agent-run", data }));
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const tools = new Map<string, { execute: (...args: unknown[]) => Promise<unknown> }>();
	const ctx = {
		cwd: process.cwd(),
		isIdle: () => true,
		sessionManager: { getBranch: () => entries },
		modelRegistry: { getAvailable: () => [] },
		ui: { notify: vi.fn(), setStatus: vi.fn() },
	};
	const pi = {
		on: (name: string, handler: (event: unknown, ctx: unknown) => unknown) => handlers.set(name, handler),
		registerTool: (tool: { name: string; execute: (...args: unknown[]) => Promise<unknown> }) =>
			tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		sendMessage: vi.fn(),
		appendEntry: vi.fn((customType: string, data: ReturnType<typeof storedRun>) =>
			entries.push({ type: "custom", customType, data }),
		),
	};
	vi.spyOn(profiles, "discoverAgents").mockReturnValue({
		agents: [
			{
				name: "worker",
				description: "worker",
				workspace: "worktree",
				source: "bundled",
				filePath: "/worker.md",
				systemPrompt: "work",
			},
		],
		projectAgentsDir: null,
	});
	vi.spyOn(GlobalConcurrencyRegistry.prototype, "claim").mockResolvedValue({
		release: vi.fn().mockResolvedValue(undefined),
	});
	vi.spyOn(WorktreeLedger.prototype, "entries").mockResolvedValue([]);
	vi.spyOn(WorktreeLedger.prototype, "prepareWorkspace").mockResolvedValue({
		mode: "worktree",
		cwd: "/repo.worker",
		created: true,
		linkedWorktree: true,
		setup: "pre_start_completed",
	});
	const terminal = vi.spyOn(WorktreeLedger.prototype, "markTerminal").mockResolvedValue();
	const verify = vi.spyOn(WorktreeLifecycle.prototype, "verify").mockResolvedValue(receipt);
	const integrate = vi.spyOn(WorktreeLifecycle.prototype, "integrate").mockResolvedValue({
		state: "integrated",
		head: "a".repeat(40),
		target: "main",
		summary: "Integrated locally",
	});
	vi.spyOn(runner, "runAgent").mockResolvedValue("Finished");
	backgroundAgents(pi as never);
	const execute = (name: string, params: unknown) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Missing ${name}`);
		return tool.execute("call", params, undefined, undefined, ctx);
	};
	return {
		pi,
		ctx,
		verify,
		integrate,
		terminal,
		entries,
		execute,
		start: () => handlers.get("session_start")?.({}, ctx),
		shutdown: () => handlers.get("session_shutdown")?.({ reason: "reload" }, ctx),
	};
}

describe("worktree lifecycle Pi wiring", () => {
	it("holds completion until automatic verification finishes, without auto-integrating", async () => {
		const h = harness();
		let resolve!: (value: WorktreeVerification) => void;
		h.verify.mockReturnValue(
			new Promise((done) => {
				resolve = done;
			}),
		);
		await h.start();
		await h.execute("background_agent", { agent: "worker", task: "implement task" });
		await vi.waitFor(() => expect(h.verify).toHaveBeenCalledOnce());
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(h.terminal).toHaveBeenCalledOnce();
		resolve(receipt);
		await vi.waitFor(() => expect(h.pi.sendMessage).toHaveBeenCalledOnce());
		expect(h.pi.sendMessage.mock.calls[0]?.[0].content).toContain("verification: passed");
		expect(h.integrate).not.toHaveBeenCalled();
	});

	it("restores interrupted checks as retryable rather than passing or hanging", async () => {
		const h = harness([
			storedRun({ verification: { state: "checking", summary: "checking" }, delivery: "none" }),
		]);
		await h.start();
		expect(h.pi.sendMessage.mock.calls[0]?.[0].content).toContain("verification: interrupted");
		expect(h.verify).not.toHaveBeenCalled();
		await h.execute("agent_control", { action: "verify", id: "0123456789ab" });
		expect(h.verify).toHaveBeenCalledOnce();
	});

	it("requires an explicitly reviewed revision and persists intent before integrating", async () => {
		const h = harness([storedRun()]);
		await h.start();
		await expect(h.execute("agent_control", { action: "integrate", id: "0123456789ab" })).rejects.toThrow(
			"exact reviewed revision",
		);
		expect(h.integrate).not.toHaveBeenCalled();
		await h.execute("agent_control", { action: "integrate", id: "0123456789ab", revision: "a".repeat(40) });
		expect(h.integrate).toHaveBeenCalledOnce();
		expect(
			h.entries.some(
				(entry) => (entry.data as { integration?: { state: string } }).integration?.state === "integrating",
			),
		).toBe(true);
	});

	it("does not integrate if durable intent cannot be written", async () => {
		const h = harness([storedRun()]);
		await h.start();
		h.pi.appendEntry.mockImplementation(() => {
			throw new Error("disk full");
		});
		await expect(
			h.execute("agent_control", { action: "integrate", id: "0123456789ab", revision: "a".repeat(40) }),
		).rejects.toThrow("no merge was started");
		expect(h.integrate).not.toHaveBeenCalled();
	});

	it("aborts in-flight verification on reload without delivering a stale completion", async () => {
		const h = harness();
		h.verify.mockImplementation(
			async (_cwd, _id, signal) =>
				new Promise((resolve) => {
					signal?.addEventListener("abort", () => resolve({ state: "interrupted", summary: "cancelled" }), {
						once: true,
					});
				}),
		);
		await h.start();
		await h.execute("background_agent", { agent: "worker", task: "implement task" });
		await vi.waitFor(() => expect(h.verify).toHaveBeenCalledOnce());
		await h.shutdown();
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});
});
