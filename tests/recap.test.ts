import { buildSessionContext, type convertToLlm, SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { normalizeRecap, recapMessages } from "../extensions/recap/index.js";

describe("idle recap", () => {
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

	it("bounds verbose and malformed responses", () => {
		const words = normalizeRecap(Array.from({ length: 200 }, (_, index) => `word${index}`).join(" "));
		expect(words.split(/\s+/)).toHaveLength(20);
		expect(words.endsWith("…")).toBe(true);

		const longWord = normalizeRecap("x".repeat(1_000));
		expect([...longWord]).toHaveLength(240);
		expect(longWord.endsWith("…")).toBe(true);
	});
});
