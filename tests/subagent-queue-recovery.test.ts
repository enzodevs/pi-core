import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@earendil-works/pi-agent-core";
import { AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { createSidecarChannel, listPendingCommands, writeCommand } from "../extensions/subagent/channel.ts";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.ts";
import { createChildLineage } from "../extensions/subagent/protocol.ts";
import { createTmuxChildBridge } from "../extensions/subagent/tui-bridge.ts";

it("replays a private reply dropped by native queue editing once Pi becomes idle", async () => {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-queue-recovery-"));
	const lineage = createChildLineage({
		parent: null,
		runId: "abcd1234",
		agent: "worker",
		allowedChildren: [],
		limits: DEFAULT_SUBAGENT_LIMITS,
		registryPath: path.join(root, "registry.json"),
	});
	const channel = createSidecarChannel({ runRoot: path.join(root, "runs"), lineage });
	const agent = new Agent({
		streamFn: () => {
			throw new Error("No provider request expected in queue fixture");
		},
	});
	const entries: unknown[] = [];
	let sends = 0;
	const sdk = {
		isStreaming: true,
		agent,
		_steeringMessages: [],
		_followUpMessages: [],
		_emitQueueUpdate() {},
		async _startRun({ message }: { message: { customType: string; details: unknown } }) {
			this.isStreaming = true;
			entries.push({ type: "custom_message", customType: message.customType, details: message.details });
		},
	};
	const pi = {
		sendMessage(
			message: Parameters<AgentSession["sendCustomMessage"]>[0],
			options: Parameters<AgentSession["sendCustomMessage"]>[1],
		) {
			sends++;
			void AgentSession.prototype.sendCustomMessage.call(sdk as unknown as AgentSession, message, options);
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		sessionManager: { getBranch: () => entries, getSessionFile: () => "/child.jsonl" },
		isIdle: () => !sdk.isStreaming && !agent.hasQueuedMessages(),
		ui: { notify() {} },
	} as unknown as ExtensionContext;
	const bridge = createTmuxChildBridge(pi, lineage, lineage.limits, {
		PI_CORE_SUBAGENT_CHANNEL: channel.directory,
		PI_CORE_SUBAGENT_CHANNEL_TOKEN: channel.token,
	});
	if (!bridge) throw new Error("Missing bridge");
	try {
		bridge.start(ctx);
		bridge.publishParentQuestion("question1", "Which API?");
		const id = writeCommand(channel, { type: "reply", questionId: "question1", text: "Use A" });
		bridge.reconcile();
		await Promise.resolve();
		await Promise.resolve();
		expect(agent.hasQueuedMessages()).toBe(true);
		// Actual SDK path used by native Alt+Up, including invisible custom control messages.
		expect(AgentSession.prototype.clearQueue.call(sdk as unknown as AgentSession)).toEqual({
			steering: [],
			followUp: [],
		});
		expect(agent.hasQueuedMessages()).toBe(false);
		expect(writeCommand(channel, { type: "reply", questionId: "question1", text: "Use A" })).toBe(id);
		bridge.reconcile();
		await Promise.resolve();
		await Promise.resolve();
		expect(sends).toBe(1); // Never duplicate a potentially active native queue.
		sdk.isStreaming = false;
		bridge.reconcile();
		await Promise.resolve();
		await Promise.resolve();
		expect(sends).toBe(2);
		expect(bridge.isQuestionPending()).toBe(false);
		expect(listPendingCommands(channel)).toEqual([]);
		bridge.reconcile();
		await Promise.resolve();
		expect(sends).toBe(2);
	} finally {
		bridge.stopForReload();
		fs.rmSync(root, { recursive: true, force: true });
	}
});
