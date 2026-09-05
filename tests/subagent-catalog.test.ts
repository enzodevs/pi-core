import { describe, expect, it } from "vitest";
import { buildAgentCatalog } from "../extensions/subagent/catalog.ts";

const profiles = [
	{ name: "worker", description: "Implementation" },
	{ name: "reviewer", description: "Read-only review" },
];
const models = [{ provider: "example", id: "gpt-6-astra", name: "GPT 6 Astra" }];

describe("agent catalog", () => {
	it("searches display names and IDs without changing launch identifiers", () => {
		const result = buildAgentCatalog(profiles, models, "GPT 6 ASTRA");
		expect(result.agents).toEqual(profiles);
		expect(result.models).toEqual([{ model: "example/gpt-6-astra", name: "GPT 6 Astra" }]);
		expect(buildAgentCatalog(profiles, models, "example/gpt-6").models).toEqual(result.models);
	});

	it("reports no matches definitively", () => {
		expect(buildAgentCatalog(profiles, models, "missing")).toMatchObject({
			models: [],
			modelsMatched: 0,
			modelsOmitted: 0,
		});
		expect(buildAgentCatalog([], [])).toMatchObject({ agents: [], models: [] });
	});

	it("bounds output and reports omissions without cutting identifiers", () => {
		const result = buildAgentCatalog(Array(20).fill(profiles[0]), Array(20).fill(models[0]));
		expect(result.agents).toHaveLength(12);
		expect(result.models).toHaveLength(12);
		expect(result).toMatchObject({ agentsOmitted: 8, modelsMatched: 20, modelsOmitted: 8 });
		const oversized = buildAgentCatalog(
			[{ name: "x".repeat(257), description: "" }],
			[{ provider: "example", id: "x".repeat(257), name: "" }],
		);
		expect(oversized).toMatchObject({ agents: [], agentsOmitted: 1, models: [], modelsOmitted: 1 });
	});
});
