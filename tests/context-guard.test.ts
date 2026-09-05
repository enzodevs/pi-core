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
	it("delivers every small parallel result intact before treating it as history", () => {
		const results = Array.from({ length: 8 }, (_, index) => ({
			...toolResult("read", `result ${index}\n${"source\n".repeat(250)}`),
			toolCallId: `parallel-${index}`,
		}));
		const messages = [{ role: "user", content: "inspect the modules" }, ...results];
		const projection = projectToolContext(messages);
		expect(projection.messages).toEqual(messages);
		expect(projection.stats.compressedResults).toBe(0);
	});

	it("shares a parallel batch budget without starving the first result", () => {
		const results = Array.from({ length: 6 }, (_, index) => ({
			...toolResult("read", `file ${index}\n${"source\n".repeat(250)}`),
			toolCallId: `parallel-${index}`,
		}));
		const projection = projectToolContext(results, { ...tightConfig, totalToolBytes: 2400 });
		for (const result of projection.messages) {
			expect(result.content[0]?.text).toContain("source");
			expect(Buffer.byteLength(result.content[0]?.text ?? "")).toBeLessThanOrEqual(400);
		}
		expect(projection.stats.projectedBytes).toBeLessThanOrEqual(2400);
	});

	it("does not advertise or shrink an artifact when the full result fits", () => {
		const result = toolResult("read", "short evidence");
		const projection = projectToolContext(
			[result],
			tightConfig,
			new Map([[result.toolCallId, "0123456789abcdef"]]),
		);
		expect(projection.messages[0]).toBe(result);
	});

	it("merges overlapping windows in source order without deduplicating structural lines", () => {
		const source = [
			"// start",
			...Array.from({ length: 100 }, (_, index) => `padding ${index}`),
			"function important() {",
			"  if (ready) {",
			"    important();",
			"  }",
			"}",
			"// end",
		].join("\n");
		const result = compressToolOutput({
			toolName: "read",
			text: source,
			isError: false,
			maxBytes: 700,
			queryTerms: ["important"],
		});
		expect(result.match(/function important/g)).toHaveLength(1);
		expect(result).toContain("  }\n}");
		expect(result.indexOf("function important")).toBeLessThan(result.indexOf("    important();"));
		expect(result).toContain("gaps omitted");
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(700);
	});

	it("preserves identical structural lines at distinct source positions", () => {
		const prefix = "if (a) {\n}\n\nif (b) {\n}\n";
		const result = compressToolOutput({
			toolName: "read",
			text: `${prefix}${"padding\n".repeat(100)}`,
			isError: false,
			maxBytes: 500,
		});
		expect(result).toContain(prefix);
	});

	it("does not let repeated status lines hide a later failing test", () => {
		const text = [
			...Array.from({ length: 80 }, (_, index) => `Tests passed suite ${index}`),
			"✖ exact assertion title",
			"AssertionError: expected 42, received 41",
			...Array.from({ length: 80 }, (_, index) => `cleanup record ${index}`),
		].join("\n");
		const result = compressToolOutput({ toolName: "bash", text, isError: true, maxBytes: 900 });
		expect(result).toContain("✖ exact assertion title");
		expect(result).toContain("expected 42, received 41");
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(900);
	});

	it("marks clipped long lines and respects UTF-8 byte budgets", () => {
		const result = compressToolOutput({
			toolName: "read",
			text: "界".repeat(1000),
			isError: false,
			maxBytes: 500,
		});
		expect(result).toContain("line truncated");
		expect(result).not.toContain("�");
		expect(Buffer.byteLength(result)).toBeLessThanOrEqual(500);
	});

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
