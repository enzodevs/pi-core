import { describe, expect, it } from "vitest";
import {
	type ContextGuardConfig,
	compressToolOutput,
	extractQueryTerms,
	projectToolContext,
} from "../extensions/context-guard/compressor.js";

function toolResult(toolName: string, text: string, isError = false) {
	return {
		role: "toolResult" as const,
		toolCallId: `${toolName}-1`,
		toolName,
		content: [{ type: "text" as const, text }],
		isError,
		timestamp: 1,
	};
}

const tightConfig: ContextGuardConfig = {
	totalToolBytes: 900,
	recentResults: 2,
	bashBytes: 500,
	readBytes: 600,
	searchBytes: 400,
	defaultBytes: 400,
	errorBytes: 650,
	historicalBytes: 180,
};

describe("context guard strategic compression", () => {
	it("leaves already-small results unchanged", () => {
		expect(
			compressToolOutput({ toolName: "bash", text: "3 tests passed", isError: false, maxBytes: 100 }),
		).toBe("3 tests passed");
	});

	it("keeps diagnostics and the command tail while dropping repetitive build noise", () => {
		const output = [
			"npm run check",
			...Array.from({ length: 100 }, (_, index) => `compiling generated module ${index}`),
			"src/store.ts:42:7 error TS2322: Type 'string' is not assignable to number",
			...Array.from({ length: 100 }, (_, index) => `bundling generated module ${index}`),
			"make: *** [Makefile:30: check] Error 2",
		].join("\n");
		const compressed = compressToolOutput({
			toolName: "bash",
			text: output,
			isError: true,
			maxBytes: 900,
			queryTerms: ["store.ts"],
		});

		expect(Buffer.byteLength(compressed)).toBeLessThanOrEqual(900);
		expect(compressed).toContain("src/store.ts:42:7 error TS2322");
		expect(compressed).toContain("make: *** [Makefile:30: check] Error 2");
		expect(compressed).toContain("context-guard");
		expect(compressed).not.toContain("generated module 50");
	});

	it("uses the latest user task to preserve matching evidence from a large read", () => {
		const readResult = toolResult(
			"read",
			[
				...Array.from({ length: 80 }, (_, index) => `unrelated line ${index}`),
				"export function resolveCheckoutState(cacheKey: string) {",
				"  return checkoutCache.get(cacheKey);",
				"}",
				...Array.from({ length: 80 }, (_, index) => `other line ${index}`),
			].join("\n"),
		);
		const messages = [
			{ role: "user", content: "Trace resolveCheckoutState and explain the cache key" },
			readResult,
		];
		const terms = extractQueryTerms(messages);
		const compressed = compressToolOutput({
			toolName: "read",
			text: readResult.content[0].text,
			isError: false,
			maxBytes: 700,
			queryTerms: terms,
		});

		expect(terms).toContain("resolvecheckoutstate");
		expect(compressed).toContain("resolveCheckoutState");
		expect(compressed).toContain("checkoutCache.get(cacheKey)");
	});

	it("applies a newest-first rolling budget and aggressively receipts old success output", () => {
		const old = toolResult("bash", "old noise\n".repeat(300));
		const recentError = toolResult("bash", `${"new noise\n".repeat(100)}FATAL: migration failed\n`, true);
		const messages = [
			{ role: "user", content: "Fix the migration failure" },
			old,
			{ role: "assistant", content: [] },
			recentError,
		];
		const projection = projectToolContext(messages, tightConfig);
		const projectedOld = projection.messages[1] as typeof old;
		const projectedError = projection.messages[3] as typeof recentError;

		expect(projectedError.content[0].text).toContain("FATAL: migration failed");
		expect(Buffer.byteLength(projectedOld.content[0].text)).toBeLessThanOrEqual(180);
		expect(projection.stats.compressedResults).toBe(2);
		expect(projection.stats.projectedBytes).toBeLessThan(projection.stats.originalBytes / 4);
		expect(old.content[0].text).toContain("old noise");
	});

	it("advertises indexed full output inside the same strict projection budget", () => {
		const result = toolResult("bash", "noise\n".repeat(1000));
		const artifacts = new Map([[result.toolCallId, "0123456789abcdef"]]);
		const config = { ...tightConfig, totalToolBytes: 500, bashBytes: 500 };
		const projection = projectToolContext(
			[{ role: "user", content: "find the exact failure" }, result],
			config,
			artifacts,
		);
		const projected = projection.messages[1] as typeof result;

		expect(projected.content.at(-1)?.text).toContain("0123456789abcdef");
		expect(projected.content.at(-1)?.text).toContain("context_lookup");
		expect(projection.stats.projectedBytes).toBeLessThanOrEqual(config.totalToolBytes);
	});

	it("strictly enforces the aggregate budget after many success and error results", () => {
		const config = { ...tightConfig, totalToolBytes: 100, historicalBytes: 80 };
		const messages = [
			{ role: "user", content: "diagnose failures" },
			...Array.from({ length: 12 }, (_, index) =>
				toolResult("bash", `${index % 2 ? "FATAL failure" : "routine output"}\n`.repeat(80), index % 2 === 1),
			),
		];
		const projection = projectToolContext(messages, config);

		expect(projection.stats.projectedBytes).toBeLessThanOrEqual(config.totalToolBytes);
	});

	it("preserves block ordering and metadata while replacing oversized text", () => {
		const message = {
			...toolResult("read", "source line\n".repeat(300)),
			content: [
				{ type: "image", data: "abc", mimeType: "image/png" },
				{ type: "text", text: "source line\n".repeat(300), citation: "source.ts:1" },
			],
		};
		const projection = projectToolContext(
			[{ role: "user", content: "inspect source" }, message],
			tightConfig,
		);
		const projected = projection.messages[1] as typeof message;

		expect(projected.content.map((block) => block.type)).toEqual(["image", "text"]);
		expect(projected.content[1]).toMatchObject({ citation: "source.ts:1" });
		expect(Buffer.byteLength(projected.content[1].text ?? "")).toBeLessThanOrEqual(600);
	});
});
