import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import sessionTitle, {
	firstExchange,
	normalizeSessionTitle,
	preferredSessionTitleModel,
	SESSION_TITLE_MAX_SOURCE_CHARS,
} from "../extensions/session-title/index.js";

describe("session title", () => {
	it("does not generate a title after an aborted run", () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const getSessionName = vi.fn(() => "Existing title");
		sessionTitle({
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers.set(event, handler);
			},
			getSessionName,
		} as unknown as ExtensionAPI);
		const ctx = {} as ExtensionContext;
		handlers.get("agent_settled")?.({ aborted: true }, ctx);
		expect(getSessionName).not.toHaveBeenCalled();
		handlers.get("agent_settled")?.({ aborted: false }, ctx);
		expect(getSessionName).toHaveBeenCalledOnce();
	});

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
