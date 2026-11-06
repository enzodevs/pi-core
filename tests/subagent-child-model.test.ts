import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.ts";
import { buildChildArgs } from "../extensions/subagent/runner.ts";

function modelArg(requested?: string, agentModel?: string, parent = true): string | undefined {
	const args = buildChildArgs(
		{
			ctx: { model: parent ? { provider: "openai", id: "gpt-6-astra" } : undefined } as ExtensionContext,
			model: requested,
			agent: {
				name: "worker",
				description: "worker",
				systemPrompt: "work",
				source: "bundled",
				filePath: "/worker.md",
				tools: ["read"],
				model: agentModel,
			},
			lineage: {
				version: 1,
				runId: "abc",
				rootRunId: "abc",
				parentRunId: null,
				agent: "worker",
				depth: 1,
				ancestry: ["abc"],
				allowedChildren: [],
				limits: DEFAULT_SUBAGENT_LIMITS,
				registryPath: "/tmp/registry.json",
			},
		},
		"/tmp/system.md",
	);
	const index = args.indexOf("--model");
	return index < 0 ? undefined : args[index + 1];
}

describe("subagent child model", () => {
	it("prefers the call, then the profile, then the parent model", () => {
		expect(modelArg("openai/gpt-6-sol", "openai/gpt-6-luna")).toBe("openai/gpt-6-sol");
		expect(modelArg(undefined, "openai/gpt-6-luna")).toBe("openai/gpt-6-luna");
		expect(modelArg()).toBe("openai/gpt-6-astra");
	});

	it("omits the flag when nothing selects a model", () => {
		expect(modelArg(undefined, undefined, false)).toBeUndefined();
	});
});
