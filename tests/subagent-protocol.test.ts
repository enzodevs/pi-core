import { describe, expect, it } from "vitest";
import type { AgentConfig } from "../extensions/subagent/agents.js";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.js";
import {
	ASK_PARENT_PROTOCOL,
	CHILD_START_PROTOCOL,
	COMPLETION_MESSAGE_TYPE,
	COMPLETION_PROTOCOL,
	createChildLineage,
	decideDelegation,
	decodeChildLineage,
	encodeChildLineage,
	ownsDirectChild,
	RpcEventTracker,
} from "../extensions/subagent/protocol.js";
import { buildChildTools, parentReplyCommand } from "../extensions/subagent/runner.js";

const registryPath = "/tmp/pi-core-test-concurrency.json";
const first = createChildLineage({
	parent: null,
	runId: "11111111",
	agent: "worker",
	allowedChildren: ["reviewer"],
	limits: { ...DEFAULT_SUBAGENT_LIMITS },
	registryPath,
});

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		tools: ["read"],
		children: ["reviewer"],
		systemPrompt: "work",
		source: "bundled",
		filePath: "/agent.md",
		...overrides,
	};
}

describe("subagent lineage and delegation", () => {
	it("round-trips validated ancestry and rejects a forged parent", () => {
		expect(decodeChildLineage(encodeChildLineage(first))).toEqual(first);
		const forged = { ...first, parentRunId: "22222222" };
		expect(decodeChildLineage(Buffer.from(JSON.stringify(forged)).toString("base64url"))).toBeNull();
	});

	it("enforces named permission, self, depth, and child-count decisions", () => {
		const known = new Set(["worker", "reviewer", "scout"]);
		expect(
			decideDelegation({
				lineage: first,
				target: "reviewer",
				knownAgents: known,
				childrenStarted: 0,
				limits: first.limits,
			}),
		).toEqual({ allowed: true });
		expect(
			decideDelegation({
				lineage: first,
				target: "scout",
				knownAgents: known,
				childrenStarted: 0,
				limits: first.limits,
			}),
		).toMatchObject({ allowed: false, code: "permission" });
		expect(
			decideDelegation({
				lineage: first,
				target: "worker",
				knownAgents: known,
				childrenStarted: 0,
				limits: first.limits,
			}),
		).toMatchObject({ allowed: false, code: "self" });
		expect(
			decideDelegation({
				lineage: first,
				target: "reviewer",
				knownAgents: known,
				childrenStarted: first.limits.maxChildrenPerRun,
				limits: first.limits,
			}),
		).toMatchObject({ allowed: false, code: "children" });
		const atDepth = { ...first, depth: first.limits.maxDepth };
		expect(
			decideDelegation({
				lineage: atDepth,
				target: "reviewer",
				knownAgents: known,
				childrenStarted: 0,
				limits: first.limits,
			}),
		).toMatchObject({ allowed: false, code: "depth" });
	});

	it("allows control only for direct descendants", () => {
		const direct = createChildLineage({
			parent: first,
			runId: "22222222",
			agent: "reviewer",
			allowedChildren: [],
			limits: first.limits,
			registryPath,
		});
		const grandchild = createChildLineage({
			parent: direct,
			runId: "33333333",
			agent: "scout",
			allowedChildren: [],
			limits: first.limits,
			registryPath,
		});
		const ownership = (lineage: typeof first) => ({
			id: lineage.runId,
			parentRunId: lineage.parentRunId,
			depth: lineage.depth,
			ancestry: lineage.ancestry,
		});
		expect(ownsDirectChild(first, ownership(direct))).toBe(true);
		expect(ownsDirectChild(first, ownership(grandchild))).toBe(false);
		expect(ownsDirectChild(null, ownership(first))).toBe(true);
	});

	it("preserves explicit tool restrictions while adding only required controls", () => {
		expect(buildChildTools(agent(), first)).toEqual([
			"read",
			"ask_parent",
			"background_agent",
			"agent_control",
		]);
		expect(buildChildTools(agent({ children: [] }), { ...first, allowedChildren: [] })).toEqual([
			"read",
			"ask_parent",
		]);
	});
});

describe("RPC ask/reply and nested waiting protocol", () => {
	it("uses a steering prompt for an early reply and a direct prompt once idle", () => {
		expect(parentReplyCommand("Use API A", false)).toMatchObject({
			type: "prompt",
			streamingBehavior: "steer",
		});
		expect(parentReplyCommand("Use API A", true)).not.toHaveProperty("streamingBehavior");
	});

	it("parks on ask_parent, accepts the matching reply, and then settles", () => {
		const tracker = new RpcEventTracker(128);
		const question = tracker.consume({
			type: "tool_execution_end",
			toolName: "ask_parent",
			result: { details: { protocol: ASK_PARENT_PROTOCOL, id: "aaaaaaaa", question: "Which API?" } },
		});
		expect(question).toMatchObject({ type: "question", question: { text: "Which API?" } });
		expect(tracker.consume({ type: "agent_settled" })).toEqual({ type: "settled", waiting: true });
		expect(() => tracker.acceptReply("bbbbbbbb")).toThrow("not pending");
		tracker.acceptReply("aaaaaaaa");
		tracker.consume({
			type: "message_end",
			message: {
				role: "assistant",
				content: [{ type: "text", text: "Implemented API A." }],
				stopReason: "stop",
			},
		});
		expect(tracker.consume({ type: "agent_settled" })).toEqual({
			type: "settled",
			waiting: false,
			output: "Implemented API A.",
		});
	});

	it("keeps a delegating child alive until its own direct child returns", () => {
		const tracker = new RpcEventTracker(128);
		expect(
			tracker.consume({
				type: "tool_execution_end",
				toolName: "background_agent",
				isError: false,
				result: { details: { protocol: CHILD_START_PROTOCOL, id: "bbbbbbbb" } },
			}),
		).toEqual({ type: "nested_started", id: "bbbbbbbb" });
		expect(tracker.consume({ type: "agent_settled" })).toMatchObject({ waiting: true });
		expect(
			tracker.consume({
				type: "message_end",
				message: {
					role: "custom",
					customType: COMPLETION_MESSAGE_TYPE,
					details: { protocol: COMPLETION_PROTOCOL, id: "bbbbbbbb" },
				},
			}),
		).toEqual({ type: "nested_finished", id: "bbbbbbbb" });
		tracker.consume({
			type: "message_end",
			message: { role: "assistant", content: [{ type: "text", text: "Merged child findings." }] },
		});
		expect(tracker.consume({ type: "agent_settled" })).toMatchObject({
			waiting: false,
			output: "Merged child findings.",
		});
	});

	it("rejects an oversized child question at the RPC boundary", () => {
		const tracker = new RpcEventTracker(8);
		expect(() =>
			tracker.consume({
				type: "tool_execution_end",
				toolName: "ask_parent",
				result: {
					details: { protocol: ASK_PARENT_PROTOCOL, id: "aaaaaaaa", question: "too long a question" },
				},
			}),
		).toThrow("oversized");
	});
});
