import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
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
import {
	buildChildArgs,
	buildChildTools,
	CONTEXT_GUARD_EXTENSION_PATH,
	parentPromptCommand,
	SUBAGENT_EXTENSION_PATH,
} from "../extensions/subagent/runner.js";

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

	it("enforces named permission, self, and depth decisions without a start-count limit", () => {
		const known = new Set(["worker", "reviewer", "scout"]);
		expect(
			decideDelegation({ lineage: first, target: "reviewer", knownAgents: known, limits: first.limits }),
		).toEqual({ allowed: true });
		expect(
			decideDelegation({ lineage: first, target: "scout", knownAgents: known, limits: first.limits }),
		).toMatchObject({ allowed: false, code: "not_permitted" });
		expect(
			decideDelegation({ lineage: first, target: "worker", knownAgents: known, limits: first.limits }),
		).toMatchObject({ allowed: false, code: "self" });
		const atDepth = { ...first, depth: first.limits.maxDepth };
		expect(
			decideDelegation({ lineage: atDepth, target: "reviewer", knownAgents: known, limits: first.limits }),
		).toMatchObject({ allowed: false, code: "max_depth" });
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
		expect(
			buildChildTools(agent({ tools: ["read", "context_lookup"], children: [] }), {
				...first,
				allowedChildren: [],
			}),
		).toEqual(["read", "context_lookup", "ask_parent"]);
	});

	it("keeps empty or invalid-only profiles restricted to the child control tool", () => {
		const ctx = { model: null, thinkingLevel: "low" } as unknown as ExtensionContext;
		const restricted = agent({ tools: undefined, children: [] });
		const args = buildChildArgs(
			{ agent: restricted, ctx, lineage: { ...first, allowedChildren: [] } },
			"/tmp/system.md",
		);
		const toolsIndex = args.indexOf("--tools");

		expect(buildChildTools(restricted, { ...first, allowedChildren: [] })).toEqual(["ask_parent"]);
		expect(toolsIndex).toBeGreaterThan(-1);
		expect(args[toolsIndex + 1]).toBe("ask_parent");
	});

	it.each([
		"/repo/.pi/extensions/pi-core/extensions/subagent/index.ts",
		"/tmp/pi-package-install-123/extensions/subagent/index.ts",
	])("explicitly loads a %s parent extension while retaining the child tool allowlist", (extensionPath) => {
		const ctx = {
			model: { provider: "openai", id: "gpt-test" },
			thinkingLevel: "high",
		} as ExtensionContext;
		const args = buildChildArgs({ agent: agent(), ctx, lineage: first }, "/tmp/system.md", extensionPath);
		const extensionIndex = args.indexOf("--extension");
		const toolsIndex = args.indexOf("--tools");

		expect(args.slice(0, 3)).toEqual(["--mode", "rpc", "--no-session"]);
		expect(args[extensionIndex + 1]).toBe(path.resolve(extensionPath));
		expect(args).toContain(path.resolve(CONTEXT_GUARD_EXTENSION_PATH));
		expect(args).toContain("--no-extensions");
		expect(args).toContain("--no-skills");
		expect(args).toContain("--no-prompt-templates");
		expect(args[toolsIndex + 1]?.split(",")).toEqual([
			"read",
			"ask_parent",
			"background_agent",
			"agent_control",
		]);
		expect(args).toContain("openai/gpt-test");
		expect(args).toContain("high");
	});

	it("resolves the explicit child extension to this loaded package instance", () => {
		expect(path.isAbsolute(SUBAGENT_EXTENSION_PATH)).toBe(true);
		expect(SUBAGENT_EXTENSION_PATH).toMatch(/extensions[/\\]subagent[/\\]index\.ts$/);
		expect(fs.existsSync(SUBAGENT_EXTENSION_PATH)).toBe(true);
		expect(CONTEXT_GUARD_EXTENSION_PATH).toMatch(/extensions[/\\]context-guard[/\\]index\.ts$/);
		expect(fs.existsSync(CONTEXT_GUARD_EXTENSION_PATH)).toBe(true);
	});
});

describe("RPC ask/reply and nested waiting protocol", () => {
	it("always lets the SDK start or queue parent prompts, even after an idle event", () => {
		expect(parentPromptCommand("Use API A")).toEqual({
			type: "prompt",
			message: "Use API A",
			streamingBehavior: "steer",
		});
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
