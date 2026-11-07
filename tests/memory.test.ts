import { Buffer } from "node:buffer";
import {
	type BeforeAgentStartEvent,
	type BeforeAgentStartEventResult,
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
	type SessionStartEvent,
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

function harness(manager = SessionManager.inMemory("/fixture")) {
	vi.stubEnv("PI_CORE_MEMORY_CONSOLIDATOR", "0");
	let start!: (
		event: BeforeAgentStartEvent,
		ctx: ExtensionContext,
	) => Promise<BeforeAgentStartEventResult | undefined>;
	let initialize!: (event: SessionStartEvent, ctx: ExtensionContext) => Promise<void>;
	const exec = vi.fn().mockResolvedValue({ code: 0, stdout: "[]", stderr: "", killed: false });
	memoryContext({
		on: (name: string, handler: unknown) => {
			if (name === "before_agent_start") start = handler as typeof start;
			if (name === "session_start") initialize = handler as typeof initialize;
		},
		appendEntry: (type: string, data: unknown) => manager.appendCustomEntry(type, data),
		registerCommand: vi.fn(),
		exec,
	} as unknown as ExtensionAPI);
	const ctx = { cwd: "/fixture", sessionManager: manager } as unknown as ExtensionContext;
	return {
		manager,
		exec,
		start: (event: BeforeAgentStartEvent) => start(event, ctx),
		initialize: (reason: SessionStartEvent["reason"]) => initialize({ type: "session_start", reason }, ctx),
	};
}

const user = (prompt: string, messageType?: "user") => ({ messageType, prompt }) as BeforeAgentStartEvent;

describe("memory start events", () => {
	it.each(["user", undefined] as const)(
		"reserves the opening lookup for a user prompt (%s)",
		async (messageType) => {
			const h = harness();
			const custom = {
				messageType: "custom",
				message: { customType: "completion", content: "Finished", display: false },
			} as BeforeAgentStartEvent;
			expect(await h.start(custom)).toBeUndefined();
			expect(await h.start(user("  ", messageType))).toBeUndefined();
			expect(h.exec).not.toHaveBeenCalled();
			await h.start(user("Opening question", messageType));
			expect(h.exec).toHaveBeenCalledTimes(2);
			for (const [, args] of h.exec.mock.calls)
				expect(args).toEqual(expect.arrayContaining(["search", "Opening question"]));
			await h.start(custom);
			await h.start(user("Later question", messageType));
			expect(h.exec).toHaveBeenCalledTimes(2);
			expect(h.manager.getEntries()).toMatchObject([
				{ type: "custom", customType: "pi-core-memory-lookup-attempt", data: { version: 1 } },
			]);
			expect(buildSessionContext(h.manager.getEntries()).messages).toEqual([]);
		},
	);

	it.each(["startup", "reload", "resume", "fork"] as const)(
		"does not retry empty, failed or successful attempts after %s",
		async (reason) => {
			for (const result of [
				{ code: 0, stdout: "[]" },
				{ code: 1, stdout: "" },
				{ code: 0, stdout: '[{"title":"Fact","text":"Keep tests."}]' },
			]) {
				const first = harness();
				first.exec.mockResolvedValue(result);
				await first.start(user("Opening question"));
				// A new extension instance, with only persisted session entries retained.
				const restored = harness(first.manager);
				await restored.initialize(reason);
				restored.exec.mockClear();
				expect(await restored.start(user("Later question"))).toBeUndefined();
				expect(restored.exec).not.toHaveBeenCalled();
			}
		},
	);

	it("records interrupted attempts before I/O and permits a genuinely new session", async () => {
		const first = harness();
		first.exec.mockRejectedValue(new Error("interrupted"));
		await expect(first.start(user("Opening question"))).rejects.toThrow("interrupted");
		const restored = harness(first.manager);
		await restored.initialize("reload");
		restored.exec.mockClear();
		await restored.start(user("Retry"));
		expect(restored.exec).not.toHaveBeenCalled();
		const fresh = harness();
		await fresh.initialize("new");
		fresh.exec.mockClear();
		await fresh.start(user("New opening"));
		expect(fresh.exec).toHaveBeenCalledTimes(2);
	});

	it("does not treat legacy sessions or inherited conversation as a new opening", async () => {
		const h = harness();
		h.manager.appendMessage({ role: "user", content: "Earlier request", timestamp: Date.now() });
		await h.initialize("fork");
		h.exec.mockClear();
		await h.start(user("Continue"));
		expect(h.exec).not.toHaveBeenCalled();
	});
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

	it("removes duplicate titles and exact reaffirmations but preserves changed decisions", () => {
		const context = formatMemoryContext([
			{
				title: "Preference",
				text: "# Preference\n\nKeep tests.\n\n## Reaffirmed 2026-10-20T12:00:00Z\n\nKeep tests.\n\n## Reaffirmed 2026-10-21T12:00:00Z\n\nKeep integration tests too.",
			},
		]);
		expect(context.match(/Preference/gu)).toHaveLength(1);
		expect(context.match(/Keep tests\./gu)).toHaveLength(1);
		expect(context).not.toContain("2026-10-20");
		expect(context).toContain("2026-10-21");
		expect(context).toContain("Keep integration tests too.");
	});

	it("keeps complete paragraphs and never clips a qualification or source path", () => {
		const context = formatMemoryContext([
			{
				title: "Preference",
				path: "/missing/preference.md",
				text: `Keep tests.\n\n${"Long preference ".repeat(80)}but only when explicitly authorized.`,
			},
		]);
		expect(context).toContain("Keep tests.");
		expect(context).not.toContain("Long preference");
		expect(context).toContain("Source: /missing/preference.md");
		expect(context).toContain("additional memory evidence omitted");
		const oversized = formatMemoryContext([{ title: "x".repeat(2000), text: "Fact" }]);
		expect(oversized).not.toContain("xxxx");
		expect(Buffer.byteLength(oversized)).toBeLessThanOrEqual(MAX_MEMORY_CONTEXT_BYTES);
	});

	it("bounds the number of complete entries", () => {
		const context = formatMemoryContext(
			Array.from({ length: 3 }, (_, index) => ({
				title: `Fact ${index}`,
				text: "Evidence.",
			})),
		);
		expect(context).toContain("Fact 1");
		expect(context).not.toContain("Fact 2");
		expect(context).toContain("additional memory evidence omitted");
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
