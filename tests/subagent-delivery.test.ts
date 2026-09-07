import { describe, expect, it, vi } from "vitest";

vi.hoisted(() => {
	delete process.env.PI_CORE_SUBAGENT_CONTEXT;
});

import backgroundAgents from "../extensions/subagent/index.ts";
import { decodeChildLineage } from "../extensions/subagent/protocol.ts";

const parentLineage = decodeChildLineage(process.env.PI_CORE_SUBAGENT_CONTEXT);

interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
	details?: unknown;
}

function terminalRun(id: string, overrides: Record<string, unknown> = {}) {
	return {
		id,
		agent: "worker",
		task: `task ${id}`,
		cwd: "/tmp/project",
		status: "complete",
		activity: "waiting",
		delivery: "pending",
		deliveryQueued: false,
		startedAt: 1,
		finishedAt: 2,
		output: `evidence ${id}`,
		parentRunId: parentLineage?.runId ?? null,
		rootRunId: parentLineage?.rootRunId ?? id,
		depth: (parentLineage?.depth ?? 0) + 1,
		ancestry: [...(parentLineage?.ancestry ?? []), id],
		...overrides,
	};
}

interface SentMessage {
	customType: string;
	content: string;
	display: boolean;
	details: {
		protocol: string;
		version: number;
		runs: Array<{ id: string; status: string }>;
	};
}

interface TestTool {
	name: string;
	execute: (...args: unknown[]) => Promise<unknown>;
}

function harness(initialRuns: ReturnType<typeof terminalRun>[]) {
	const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
	const tools = new Map<string, TestTool>();
	let idle = false;
	let branch: Entry[] = initialRuns.map((data) => ({
		type: "custom",
		customType: "pi-core-agent-run",
		data,
	}));
	const sent: Array<{ message: SentMessage; options: unknown }> = [];
	let sendError: Error | undefined;
	const pi = {
		on: vi.fn((name: string, handler: (event: unknown, ctx: unknown) => unknown) =>
			handlers.set(name, handler),
		),
		registerTool: vi.fn((tool: TestTool) => tools.set(tool.name, tool)),
		registerCommand: vi.fn(),
		appendEntry: vi.fn((customType: string, data: unknown) =>
			branch.push({ type: "custom", customType, data }),
		),
		sendMessage: vi.fn((message: SentMessage, options: unknown) => {
			if (sendError) throw sendError;
			sent.push({ message, options });
		}),
	};
	const ctx = {
		cwd: "/tmp/project",
		isIdle: () => idle,
		sessionManager: { getBranch: () => branch },
		modelRegistry: { getAvailable: () => [] },
		ui: { setStatus: vi.fn(), notify: vi.fn() },
	};
	backgroundAgents(pi as never);
	return {
		ctx,
		sent,
		pi,
		tool: () => tools.get("agent_control"),
		start: async () => handlers.get("session_start")?.({}, ctx),
		settle: () => handlers.get("agent_settled")?.({}, ctx),
		switchBranch: async (entries: Entry[]) => {
			branch = entries;
			await handlers.get("session_tree")?.({}, ctx);
		},
		setIdle: (value: boolean) => {
			idle = value;
		},
		failSend: (error?: Error) => {
			sendError = error;
		},
		commitLast: () => {
			const last = sent.at(-1);
			if (last)
				branch.push({
					type: "custom_message",
					customType: last.message.customType,
					details: last.message.details,
				});
		},
	};
}

async function status(h: ReturnType<typeof harness>, id?: string) {
	const tool = h.tool();
	if (!tool) throw new Error("agent_control was not registered");
	return tool.execute("call", { action: "status", id }, undefined, undefined, h.ctx);
}

describe("subagent completion delivery", () => {
	it("consumes only an explicitly read terminal result and batches remaining unread results", async () => {
		const h = harness([terminalRun("aaaaaaaa"), terminalRun("bbbbbbbb")]);
		await h.start();
		expect(h.sent).toHaveLength(0);

		await status(h, "aaaaaaaa");
		await status(h); // Overview must not consume bbbbbbbb.
		h.setIdle(true);
		h.settle();

		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.message).toMatchObject({
			display: false,
			details: {
				protocol: "pi-core.child-complete-batch.v1",
				version: 1,
				runs: [{ id: "bbbbbbbb", status: "complete" }],
			},
		});
		expect(h.sent[0]?.message.content).not.toContain("evidence aaaaaaaa");
		expect(h.sent[0]?.options).toEqual({ deliverAs: "followUp", triggerTurn: true });
	});

	it("waits through active streaming, retries a failed send, and acknowledges only a committed receipt", async () => {
		const h = harness([terminalRun("cccccccc", { status: "failed", error: "action required" })]);
		await h.start();
		h.settle();
		expect(h.sent).toHaveLength(0);

		h.setIdle(true);
		h.failSend(new Error("queue unavailable"));
		h.settle();
		expect(h.sent).toHaveLength(0);
		h.failSend();
		h.settle();
		expect(h.sent).toHaveLength(1);
		expect(h.sent[0]?.message.content).toContain("action required");

		// A queued send is not assumed committed. Once committed, settle consumes it without resending.
		h.commitLast();
		h.settle();
		expect(h.sent).toHaveLength(1);
	});

	it("reconciles append-before-persist receipts on reload and does not leak them across branches", async () => {
		const h = harness([terminalRun("dddddddd", { deliveryQueued: true })]);
		h.setIdle(true);
		await h.start();
		expect(h.sent).toHaveLength(1); // Missing committed receipt resets stale queued state.
		h.commitLast();

		await h.start();
		h.settle();
		expect(h.sent).toHaveLength(1);

		await h.switchBranch([
			{ type: "custom", customType: "pi-core-agent-run", data: terminalRun("eeeeeeee") },
		]);
		expect(h.sent).toHaveLength(2);
		expect(h.sent[1]?.message.details.runs).toEqual([expect.objectContaining({ id: "eeeeeeee" })]);
	});
});
