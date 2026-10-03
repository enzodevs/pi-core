import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.js";
import { createChildLineage, encodeChildLineage } from "../extensions/subagent/protocol.js";

describe("child tool exposure", () => {
	it("keeps ask_parent model-only rather than callable from codemode", async () => {
		const lineage = createChildLineage({
			parent: null,
			runId: "11111111",
			agent: "worker",
			allowedChildren: [],
			limits: DEFAULT_SUBAGENT_LIMITS,
			registryPath: "/tmp/pi-core-exposure-test-registry.json",
		});
		vi.stubEnv("PI_CORE_SUBAGENT_CONTEXT", encodeChildLineage(lineage));
		// A real child may have a sidecar belonging to its original lineage.
		vi.stubEnv("PI_CORE_SUBAGENT_CHANNEL", "");
		vi.stubEnv("PI_CORE_SUBAGENT_CHANNEL_TOKEN", "");
		try {
			vi.resetModules();
			const { default: backgroundAgents } = await import("../extensions/subagent/index.js");
			const tools: ToolDefinition[] = [];
			backgroundAgents({
				on: vi.fn(),
				registerCommand: vi.fn(),
				registerTool: (tool: ToolDefinition) => tools.push(tool),
			} as unknown as ExtensionAPI);
			expect(tools.find((tool) => tool.name === "ask_parent")?.exposure).toBe("model-only");
		} finally {
			vi.unstubAllEnvs();
			vi.resetModules();
		}
	});
});
