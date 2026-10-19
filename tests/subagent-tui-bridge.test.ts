import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	createSidecarChannel,
	listPendingCommands,
	openSidecarChannel,
	publishResult,
	readQuestion,
	readResult,
	writeCommand,
} from "../extensions/subagent/channel.js";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.js";
import { createChildLineage } from "../extensions/subagent/protocol.js";
import { createTmuxChildBridge } from "../extensions/subagent/tui-bridge.js";

const roots: string[] = [];
const bridges: Array<{ stopForReload(): void }> = [];

afterEach(() => {
	for (const bridge of bridges.splice(0)) bridge.stopForReload();
	vi.useRealTimers();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(persist = true, herdr = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-tui-bridge-test-"));
	roots.push(root);
	const lineage = createChildLineage({
		parent: null,
		runId: "abcd1234",
		agent: "worker",
		allowedChildren: [],
		limits: { ...DEFAULT_SUBAGENT_LIMITS, handoffBytes: 1_024 },
		registryPath: path.join(root, "concurrency.json"),
	});
	const channel = createSidecarChannel({ runRoot: path.join(root, "runs"), lineage });
	const entries: unknown[] = [];
	const messages: Array<{ message: unknown; options: unknown }> = [];
	let sent!: () => void;
	const messageSent = new Promise<void>((resolve) => {
		sent = resolve;
	});
	const pi = {
		sendMessage(message: unknown, options: unknown) {
			messages.push({ message, options });
			if (persist) entries.push({ type: "custom_message", ...(message as object) });
			sent();
		},
	} as unknown as ExtensionAPI;
	let aborted!: () => void;
	const abortSeen = new Promise<void>((resolve) => {
		aborted = resolve;
	});
	const ctx = {
		sessionManager: { getBranch: () => entries, getSessionFile: () => "/child.jsonl" },
		ui: { notify() {} },
		isIdle: () => false,
		abort: aborted,
		shutdown: vi.fn(),
	} as unknown as ExtensionContext;
	const bridge = createTmuxChildBridge(pi, lineage, lineage.limits, {
		PI_CORE_SUBAGENT_CHANNEL: channel.directory,
		PI_CORE_SUBAGENT_CHANNEL_TOKEN: channel.token,
		PI_CORE_SUBAGENT_HERDR: herdr ? "1" : undefined,
	});
	if (!bridge) throw new Error("expected bridge");
	bridges.push(bridge);
	bridge.start(ctx);
	return { bridge, channel, ctx, lineage, messages, messageSent, abortSeen, entries };
}

describe("tmux child sidecar bridge", () => {
	it("keeps a blocking parent question isolated from human pane input and applies one reply", async () => {
		const { bridge, channel, ctx, messages, messageSent } = setup();
		bridge.publishParentQuestion("question1", "Which API?");
		expect(bridge.blockHumanInputWhileWaiting(ctx)).toBe(true);
		writeCommand(channel, { type: "reply", questionId: "question1", text: "Use API A" });
		await messageSent;
		expect(messages).toHaveLength(1);
		expect(messages[0]).toMatchObject({
			message: {
				customType: "pi-core-child-control",
				content: expect.stringContaining("Parent reply: Use API A"),
				details: { questionId: "question1" },
			},
			options: { deliverAs: "steer", triggerTurn: true },
		});
		await vi.waitFor(() => {
			bridge.reconcile();
			expect(bridge.isQuestionPending()).toBe(false);
		});
		expect(readQuestion(channel)).toBeUndefined();
		expect(listPendingCommands(channel)).toEqual([]);
	});

	it("does not acknowledge a queued reply until its session receipt is persisted", async () => {
		const { bridge, channel, messages, messageSent, entries } = setup(false);
		bridge.publishParentQuestion("question1", "Which API?");
		const id = writeCommand(channel, { type: "reply", questionId: "question1", text: "Use A" });
		await messageSent;
		expect(bridge.isQuestionPending()).toBe(true);
		expect(listPendingCommands(channel)).toHaveLength(1);
		bridge.settle({ status: "complete", output: "intermediate" }, false);
		expect(readResult(channel)).toBeUndefined();
		expect(writeCommand(channel, { type: "reply", questionId: "question1", text: "Use A" })).toBe(id);
		expect(() => writeCommand(channel, { type: "reply", questionId: "question1", text: "Use B" })).toThrow(
			"different reply",
		);
		entries.push({ type: "custom_message", ...(messages[0]?.message as object) });
		await vi.waitFor(() => {
			bridge.reconcile();
			expect(listPendingCommands(channel)).toEqual([]);
		});
		expect(bridge.isQuestionPending()).toBe(false);
		expect(messages).toHaveLength(1);
	});

	it("delivers aborted settlement even while waiting for a reply or nested children", () => {
		const { bridge, channel } = setup();
		bridge.publishParentQuestion("question1", "Which API?");
		bridge.settle({ status: "complete", output: "Intermediate output." }, true);
		expect(readResult(channel)).toBeUndefined();
		bridge.settle({ status: "failed", output: "Child run aborted." }, true, true);
		expect(readResult(channel)).toMatchObject({ status: "failed", output: "Child run aborted." });
		bridge.shutdown("quit");
	});

	it("keeps parent-requested cancellation stopped when the aborted event arrives first", async () => {
		const { bridge, channel, abortSeen } = setup();
		writeCommand(channel, { type: "cancel" });
		await abortSeen;
		bridge.settle({ status: "failed", output: "Child run aborted." }, false, true);
		expect(readResult(channel)).toMatchObject({ status: "stopped" });
		bridge.shutdown("quit");
	});

	it("retains failed Herdr child TUIs across reload", async () => {
		vi.useFakeTimers();
		const { bridge, channel, ctx, lineage } = setup(true, true);
		bridge.settle({ status: "failed", output: "diagnostic" }, false);
		bridge.stopForReload();
		const restored = createTmuxChildBridge(
			{ sendMessage() {} } as unknown as ExtensionAPI,
			lineage,
			lineage.limits,
			{
				PI_CORE_SUBAGENT_CHANNEL: channel.directory,
				PI_CORE_SUBAGENT_CHANNEL_TOKEN: channel.token,
				PI_CORE_SUBAGENT_HERDR: "1",
			},
		);
		if (!restored) throw new Error("Missing restored bridge");
		bridges.push(restored);
		restored.start(ctx);
		await vi.advanceTimersByTimeAsync(3_000);
		expect(ctx.shutdown).not.toHaveBeenCalled();
	});

	it("accepts only the first terminal sidecar result", () => {
		const { channel } = setup();
		expect(publishResult(channel, { status: "complete", output: "first", finishedAt: 1 })).toBe(true);
		expect(publishResult(channel, { status: "complete", output: "second", finishedAt: 2 })).toBe(false);
		expect(readResult(channel)?.output).toBe("first");
	});

	it("publishes one bounded immutable final handoff rather than a transcript", () => {
		const { bridge, channel } = setup();
		bridge.settle({ status: "complete", output: "x".repeat(5_000) }, false);
		bridge.settle({ status: "complete", output: "replacement" }, false);
		const opened = openSidecarChannel({
			directory: channel.directory,
			token: channel.token,
			lineage: channel.metadata.lineage,
		});
		const result = readResult(opened);
		expect(result?.status).toBe("complete");
		expect(result?.output).toContain("bytes omitted]");
		expect(result?.output).not.toContain("replacement");
		expect(Buffer.byteLength(result?.output ?? "", "utf8")).toBeLessThanOrEqual(1_024);
	});

	it("remembers its terminal publication after the parent removes the run directory", () => {
		const { bridge, channel, ctx } = setup();
		bridge.settle({ status: "complete", output: "done" }, false);
		expect(readResult(channel)?.output).toBe("done");

		fs.rmSync(channel.directory, { recursive: true, force: true });
		expect(() => bridge.settle({ status: "failed", output: "late" }, false)).not.toThrow();
		expect(() => bridge.shutdown("reload")).not.toThrow();
		expect(() => bridge.start(ctx)).not.toThrow();
		expect(() => bridge.shutdown("quit")).not.toThrow();
		expect(fs.existsSync(channel.directory)).toBe(false);
	});

	it("remembers a concurrently published terminal result before later cleanup", () => {
		const { bridge, channel } = setup();
		expect(publishResult(channel, { status: "complete", output: "winner", finishedAt: 1 })).toBe(true);
		bridge.settle({ status: "complete", output: "loser" }, false);
		expect(readResult(channel)?.output).toBe("winner");

		fs.rmSync(channel.directory, { recursive: true, force: true });
		expect(() => bridge.shutdown("quit")).not.toThrow();
		expect(fs.existsSync(channel.directory)).toBe(false);
	});

	it("surfaces initial publication failure without recreating a deleted run directory", () => {
		const { bridge, channel } = setup();
		fs.rmSync(channel.directory, { recursive: true, force: true });

		expect(() => bridge.settle({ status: "complete", output: "too late" }, false)).toThrow();
		expect(fs.existsSync(channel.directory)).toBe(false);
	});
});
