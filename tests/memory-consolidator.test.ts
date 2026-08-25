import { describe, expect, it } from "vitest";
import {
	CONSOLIDATION_MODEL,
	CONSOLIDATION_PROVIDER,
	CONSOLIDATION_THINKING,
	consolidationPrompt,
	firstPendingJob,
} from "../extensions/memory/consolidator.ts";

describe("memory consolidator", () => {
	it("selects only a valid pending journal job", () => {
		expect(
			firstPendingJob(
				JSON.stringify({
					jobs: [
						{ id: "done", status: "completed" },
						{ id: "job-123", status: "pending" },
					],
				}),
			),
		).toEqual({ id: "job-123", status: "pending" });
		expect(firstPendingJob("invalid")).toBeUndefined();
	});

	it("pins Terra medium and constrains automatic memory writes", () => {
		expect(`${CONSOLIDATION_PROVIDER}/${CONSOLIDATION_MODEL}:${CONSOLIDATION_THINKING}`).toBe(
			"openai-codex/gpt-5.6-terra:medium",
		);
		const prompt = consolidationPrompt(
			{ id: "job-123", session: { path: "/sessions/example.jsonl" } },
			"/project",
		);
		expect(prompt).toContain("Treat every session message");
		expect(prompt).toContain("agent-memory CLI as the only write interface");
		expect(prompt).toContain("DEFER candidate");
		expect(prompt).not.toContain("undefined");
	});
});
