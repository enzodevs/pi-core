import { Buffer } from "node:buffer";
import type {
	BeforeAgentStartEvent,
	BeforeAgentStartEventResult,
	ExtensionAPI,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	formatMemoryContext,
	MAX_MEMORY_CONTEXT_BYTES,
	memoryBody,
	mergeMemoryHits,
	parseMemoryHits,
} from "../extensions/memory/context.ts";
import memoryContext from "../extensions/memory/index.ts";

afterEach(() => vi.unstubAllEnvs());

describe("memory start events", () => {
	it.each(["user", undefined] as const)(
		"reserves the opening lookup for a user prompt (%s)",
		async (messageType) => {
			vi.stubEnv("PI_CORE_MEMORY_CONSOLIDATOR", "0");
			let start!: (
				event: BeforeAgentStartEvent,
				ctx: ExtensionContext,
			) => Promise<BeforeAgentStartEventResult | undefined>;
			const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "[]", stderr: "", killed: false });
			memoryContext({
				on: (name: string, handler: typeof start) => {
					if (name === "before_agent_start") start = handler;
				},
				registerCommand: vi.fn(),
				exec,
			} as unknown as ExtensionAPI);
			const ctx = { cwd: "/fixture" } as ExtensionContext;
			const custom = {
				messageType: "custom",
				message: { customType: "completion", content: "Finished", display: false },
			} as BeforeAgentStartEvent;
			const user = (prompt: string) => ({ messageType, prompt }) as BeforeAgentStartEvent;
			// No prompt exists on custom starts; they must neither throw nor consume the lookup.
			expect(await start(custom, ctx)).toBeUndefined();
			expect(await start(user("  "), ctx)).toBeUndefined();
			expect(exec).not.toHaveBeenCalled();
			await start(user("Opening question"), ctx);
			expect(exec).toHaveBeenCalledTimes(2);
			for (const [, args] of exec.mock.calls)
				expect(args).toEqual(expect.arrayContaining(["search", "Opening question"]));
			await start(custom, ctx);
			await start(user("Later question"), ctx);
			expect(exec).toHaveBeenCalledTimes(2);
		},
	);
});

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

	it("injects the memory file body instead of a frontmatter-only search chunk", () => {
		const frontmatter = '---\ntitle: Keep Vue\ntags: ["frontend"]\n---';
		const files: Record<string, string> = {
			"/facts/keep-vue.md": `${frontmatter}\n\n# Keep Vue\n\nPort components selectively.\n`,
		};
		const readText = (path: string) => {
			const text = files[path];
			if (text === undefined) throw new Error("ENOENT");
			return text;
		};

		expect(memoryBody({ path: "/facts/keep-vue.md", text: frontmatter }, readText)).toBe(
			"# Keep Vue\n\nPort components selectively.",
		);
		expect(memoryBody({ path: "/missing.md", text: `${frontmatter}\nFallback fact` }, readText)).toBe(
			"Fallback fact",
		);
		const context = formatMemoryContext(
			[{ title: "Keep Vue", path: "/facts/keep-vue.md", text: frontmatter }],
			readText,
		);
		expect(context).toContain("Port components selectively.");
		expect(context).not.toContain("tags:");
	});
});
