import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
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

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
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
	const messages: Array<{ message: unknown; options: unknown }> = [];
	let sent!: () => void;
	const messageSent = new Promise<void>((resolve) => {
		sent = resolve;
	});
	const pi = {
		sendMessage(message: unknown, options: unknown) {
			messages.push({ message, options });
			sent();
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager: { getBranch: () => [] },
		ui: { notify() {} },
		abort() {},
		shutdown() {},
	} as unknown as ExtensionContext;
	const bridge = createTmuxChildBridge(pi, lineage, lineage.limits, {
		PI_CORE_SUBAGENT_CHANNEL: channel.directory,
		PI_CORE_SUBAGENT_CHANNEL_TOKEN: channel.token,
	});
	if (!bridge) throw new Error("expected bridge");
	bridge.start(ctx);
	return { bridge, channel, ctx, lineage, messages, messageSent };
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
		expect(bridge.isQuestionPending()).toBe(false);
		expect(readQuestion(channel)).toBeUndefined();
		expect(listPendingCommands(channel)).toEqual([]);
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
});
