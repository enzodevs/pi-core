import { buildSessionContext, type convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	boundedRecapMessages,
	latestAssistantTextLength,
	MIN_RECAP_ASSISTANT_CHARS,
	normalizeRecap,
	preferredRecapModel,
	RECAP_CONTEXT_MAX_MESSAGES,
	RECAP_MESSAGE_MAX_CHARS,
	RECAP_MODEL_ID,
	RECAP_MODEL_PROVIDER,
	recapMessages,
} from "../extensions/recap/index.js";

describe("idle recap", () => {
	it("prefers authenticated Codex Spark and otherwise keeps the active model", () => {
		const active = { id: "active" };
		const spark = { id: "spark" };
		const registry = {
			find: (provider: string, modelId: string) =>
				provider === RECAP_MODEL_PROVIDER && modelId === RECAP_MODEL_ID ? spark : undefined,
			hasConfiguredAuth: () => true,
		};

		expect(preferredRecapModel(registry, active)).toBe(spark);
		expect(preferredRecapModel({ ...registry, hasConfiguredAuth: () => false }, active)).toBe(active);
		expect(preferredRecapModel({ ...registry, find: () => undefined }, active)).toBe(active);
	});

	it("converts active custom context into provider messages", () => {
		type ProviderMessage = ReturnType<typeof convertToLlm>[number];
		const user = {
			role: "user",
			content: [{ type: "text", text: "Fix delivery" }],
			timestamp: 1,
		} as ProviderMessage;
		const assistant = {
			role: "assistant",
			content: [{ type: "text", text: "Implemented it" }],
			timestamp: 2,
		} as ProviderMessage;
		const messages = recapMessages([user, { role: "custom", content: "internal" }, assistant]);
		expect(messages[0]).toEqual(user);
		expect(JSON.stringify(messages[1])).toContain("internal");
		expect(messages[2]).toEqual(assistant);
	});

	it("retains compacted active-branch history", () => {
		const session = SessionManager.inMemory();
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Original task" }],
			timestamp: 1,
		});
		const keptId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Recent task" }],
			timestamp: 2,
		});
		session.appendCompaction("Completed original setup; next verify it.", keptId, 100);

		const messages = recapMessages(buildSessionContext(session.getEntries(), session.getLeafId()).messages);
		expect(JSON.stringify(messages)).toContain("Completed original setup; next verify it.");
		expect(JSON.stringify(messages)).toContain("Recent task");
	});

	it("retains active branch summaries", () => {
		const session = SessionManager.inMemory();
		const rootId = session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Root task" }],
			timestamp: 1,
		});
		session.appendMessage({
			role: "user",
			content: [{ type: "text", text: "Abandoned branch" }],
			timestamp: 2,
		});
		session.branchWithSummary(rootId, "Finished branch setup; next integrate it.");

		const messages = recapMessages(buildSessionContext(session.getEntries(), session.getLeafId()).messages);
		expect(JSON.stringify(messages)).toContain("Finished branch setup; next integrate it.");
		expect(JSON.stringify(messages)).not.toContain("Abandoned branch");
	});

	it("bounds recap context to recent visible text", () => {
		type ProviderMessage = ReturnType<typeof convertToLlm>[number];
		const messages = Array.from({ length: RECAP_CONTEXT_MAX_MESSAGES + 3 }, (_, index) => ({
			role: index % 2 === 0 ? "user" : "assistant",
			content: [
				{ type: "thinking", thinking: "private reasoning" },
				{ type: "text", text: `${index}:${"x".repeat(RECAP_MESSAGE_MAX_CHARS + 20)}` },
			],
			timestamp: index,
		})) as ProviderMessage[];

		const bounded = boundedRecapMessages(messages);
		expect(bounded.length).toBeLessThanOrEqual(RECAP_CONTEXT_MAX_MESSAGES);
		expect(bounded.length).toBeGreaterThan(0);
		expect(JSON.stringify(bounded)).not.toContain("private reasoning");
		expect(JSON.stringify(bounded)).not.toContain('"0:');
		for (const message of bounded) {
			const text = (message.content[0] as { text: string }).text;
			expect(Array.from(text).length).toBeLessThanOrEqual(RECAP_MESSAGE_MAX_CHARS);
		}
	});

	it("measures only the latest assistant's visible text", () => {
		const messages = [
			{ role: "assistant", content: [{ type: "text", text: "x".repeat(MIN_RECAP_ASSISTANT_CHARS) }] },
			{ role: "user", content: [{ type: "text", text: "y".repeat(500) }] },
			{
				role: "assistant",
				content: [
					{ type: "thinking", thinking: "z".repeat(500) },
					{ type: "text", text: "  short reply  " },
				],
			},
		];

		expect(latestAssistantTextLength(messages)).toBe("short reply".length);
		expect(latestAssistantTextLength([{ role: "user", content: [] }])).toBe(0);
	});

	it("counts Unicode characters rather than UTF-16 code units", () => {
		expect(
			latestAssistantTextLength([{ role: "assistant", content: [{ type: "text", text: "👍👍" }] }]),
		).toBe(2);
	});

	it("normalizes a terse model response", () => {
		expect(normalizeRecap('  "Implemented delivery; next run verification."\n')).toBe(
			"Implemented delivery; next run verification.",
		);
	});

	it("uses only the first non-empty response line", () => {
		expect(normalizeRecap("\nFinished implementation.\nIgnore this verbose second line.")).toBe(
			"Finished implementation.",
		);
		expect(normalizeRecap("Finished implementation.\rIgnore this CR-only second line.")).toBe(
			"Finished implementation.",
		);
	});

	it("enforces the recap word limit", () => {
		const recap =
			"You reviewed anti-slop, ran a read-only trial on UniAlgo with a detached worktree, and found about 1,313 strict hits.";
		expect(normalizeRecap(recap)).toBe(
			"You reviewed anti-slop, ran a read-only trial on UniAlgo with a detached",
		);
	});
});
