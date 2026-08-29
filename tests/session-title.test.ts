import { describe, expect, it } from "vitest";
import {
	firstExchange,
	normalizeSessionTitle,
	preferredSessionTitleModel,
	SESSION_TITLE_MAX_SOURCE_CHARS,
} from "../extensions/session-title/index.js";

describe("session title", () => {
	it("extracts and bounds the first user-assistant exchange", () => {
		const exchange = firstExchange([
			{ role: "system", content: "ignored" },
			{ role: "user", content: [{ type: "text", text: `  ${"x".repeat(1_500)}  ` }] },
			{ role: "assistant", content: [{ type: "text", text: "Implemented the first change." }] },
			{ role: "user", content: [{ type: "text", text: "A later request" }] },
		]);
		expect(exchange?.user).toHaveLength(SESSION_TITLE_MAX_SOURCE_CHARS);
		expect(exchange?.assistant).toBe("Implemented the first change.");
	});

	it("requires a completed exchange", () => {
		expect(firstExchange([{ role: "user", content: [{ type: "text", text: "Build it" }] }])).toBeUndefined();
	});

	it("normalizes a concise model title", () => {
		expect(normalizeSessionTitle('Title: "Add automatic session titles."\nExtra')).toBe(
			"Add automatic session titles",
		);
	});

	it("rejects generic malformed lengths", () => {
		expect(normalizeSessionTitle("Help")).toBe("");
		expect(normalizeSessionTitle("one two three four five six")).toBe("");
	});

	it("prefers authenticated Spark and otherwise uses the active model", () => {
		const active = { id: "active" };
		const spark = { id: "spark" };
		expect(
			preferredSessionTitleModel(
				{ find: () => spark, hasConfiguredAuth: (model) => model === spark },
				active,
			),
		).toBe(spark);
		expect(preferredSessionTitleModel({ find: () => spark, hasConfiguredAuth: () => false }, active)).toBe(
			active,
		);
	});
});
