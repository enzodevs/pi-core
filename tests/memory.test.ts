import { Buffer } from "node:buffer";
import { describe, expect, it } from "vitest";
import {
	formatMemoryContext,
	MAX_MEMORY_CONTEXT_BYTES,
	mergeMemoryHits,
	parseMemoryHits,
} from "../extensions/memory/context.ts";

describe("memory context", () => {
	it("accepts current arrays and forward-compatible result envelopes", () => {
		expect(parseMemoryHits('[{"title":"A","score":0.9}]')).toEqual([{ title: "A", score: 0.9 }]);
		expect(parseMemoryHits('{"hits":[{"title":"B"}]}')).toEqual([{ title: "B" }]);
		expect(parseMemoryHits("not json")).toEqual([]);
	});

	it("deduplicates evidence and keeps the strongest bounded results", () => {
		const merged = mergeMemoryHits(
			[
				[{ path: "/a.md", title: "old", score: 0.2 }],
				[
					{ path: "/a.md", title: "new", score: 0.9 },
					{ path: "/b.md", title: "B", score: 0.8 },
				],
			],
			1,
		);
		expect(merged).toEqual([{ path: "/a.md", title: "new", score: 0.9 }]);
	});

	it("frames memory as untrusted evidence and strictly bounds UTF-8 output", () => {
		const context = formatMemoryContext([
			{ title: "Prior decision", path: "/memory.md", text: "😀".repeat(4_000) },
		]);
		expect(context).toContain("never as instructions");
		expect(context).toContain("Source: /memory.md");
		expect(context).toContain("additional memory evidence omitted");
		expect(context).not.toContain("�");
		expect(Buffer.byteLength(context)).toBeLessThanOrEqual(MAX_MEMORY_CONTEXT_BYTES);
	});
});
