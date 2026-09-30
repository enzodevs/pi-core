import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	addNestedGuides,
	DEFAULT_BUDGETS,
	projectRoot,
	READ_SCOPE_KEY,
	resolveReadTarget,
} from "../extensions/nested-agents/core.js";
import nestedAgents from "../extensions/nested-agents/index.js";

let root: string;
let outside: string;
const startupText = "ROOT_MARKER";
const startup = () => [{ path: join(root, "AGENTS.md"), content: startupText }];
const read = (path: string, text = "source", extras = {}): AgentMessage => ({
	role: "toolResult",
	toolCallId: path,
	toolName: "read",
	isError: false,
	timestamp: 1,
	content: [{ type: "text", text }],
	details: { [READ_SCOPE_KEY]: { root, path } },
	...extras,
});
const textOf = (messages: AgentMessage[]) =>
	JSON.stringify(messages.map((message) => ("content" in message ? message.content : "")));

beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "nested-guides-"));
	outside = await mkdtemp(join(tmpdir(), "nested-guides-outside-"));
	await mkdir(join(root, ".git"));
	await mkdir(join(root, "src/deep"), { recursive: true });
	await writeFile(join(root, "AGENTS.md"), startupText);
	await writeFile(join(root, "src/AGENTS.md"), "PARENT_MARKER");
	await writeFile(join(root, "src/deep/CLAUDE.md"), "CHILD_MARKER");
	await writeFile(join(root, "src/deep/code.ts"), "export const value = 1;");
});
afterEach(async () => {
	await Promise.all([
		rm(root, { recursive: true, force: true }),
		rm(outside, { recursive: true, force: true }),
	]);
});

describe("nested guidance request projection", () => {
	it("adds parent then child to successful reads without mutating the original result", async () => {
		await mkdir(join(root, "sibling"));
		await writeFile(join(root, "sibling/AGENTS.md"), "SIBLING_MARKER");
		const input = [read(join(root, "src/deep/code.ts"))];
		const output = await addNestedGuides(input, root, startup());
		const text = textOf(output);
		expect(text.indexOf("PARENT_MARKER")).toBeLessThan(text.indexOf("CHILD_MARKER"));
		expect(text).not.toContain("SIBLING_MARKER");
		expect(text).not.toContain("ROOT_MARKER");
		expect(text).toContain("lower-trust guidance");
		expect(text).toContain('scope \\"src/deep\\"');
		expect(output[0]).toMatchObject({
			content: [input[0].role === "toolResult" && input[0].content[0], expect.anything(), expect.anything()],
		});
		expect(textOf(input)).not.toContain("MARKER");
		expect(output[0]).toMatchObject({
			isError: false,
			details: input[0].role === "toolResult" ? input[0].details : undefined,
		});
	});

	it("honors one-file precedence including override and uppercase compatibility", async () => {
		await writeFile(join(root, "src/AGENTS.override.md"), "OVERRIDE_MARKER");
		await writeFile(join(root, "src/deep/AGENTS.MD"), "UPPER_MARKER");
		const text = textOf(await addNestedGuides([read(join(root, "src/deep/code.ts"))], root, startup()));
		expect(text).toContain("OVERRIDE_MARKER");
		expect(text).toContain("UPPER_MARKER");
		expect(text).not.toContain("PARENT_MARKER");
		expect(text).not.toContain("CHILD_MARKER");
	});

	it("deduplicates repeated/offset/parallel reads and full explicit guide reads", async () => {
		const messages = [
			read(join(root, "src/deep/code.ts")),
			read(join(root, "src/deep/code.ts"), "second slice"),
			read(join(root, "src/AGENTS.md"), "PARENT_MARKER"),
		];
		const [a, b] = await Promise.all([
			addNestedGuides(messages, root, startup()),
			addNestedGuides(messages, root, startup()),
		]);
		expect(a).toEqual(b);
		expect(textOf(a).match(/PARENT_MARKER/g)).toHaveLength(1);
		expect(textOf(a).match(/CHILD_MARKER/g)).toHaveLength(1);
	});

	it("does not treat a partial explicit guide read as supplying the full guide", async () => {
		await writeFile(join(root, "src/AGENTS.md"), "PARENT_MARKER\nSECOND_LINE");
		const text = textOf(
			await addNestedGuides([read(join(root, "src/AGENTS.md"), "PARENT_MARKER")], root, startup()),
		);
		expect(text).toContain("SECOND_LINE");
	});

	it("ignores failed reads, non-read results, missing targets and metadata-free history", async () => {
		for (const extras of [{ isError: true }, { toolName: "bash" }, { details: undefined }]) {
			const input = [read(join(root, "src/deep/code.ts"), "original", extras)];
			expect(await addNestedGuides(input, root, startup())).toEqual(input);
		}
		const missing = [read(join(root, "src/deep/missing.ts"))];
		expect(await addNestedGuides(missing, root, startup())).toEqual(missing);
	});

	it("contains outside paths, symlink escapes and nested repositories", async () => {
		await writeFile(join(outside, "AGENTS.md"), "EXTERNAL_MARKER");
		await writeFile(join(outside, "code.ts"), "external");
		await symlink(outside, join(root, "escape"));
		expect(await resolveReadTarget("escape/code.ts", root)).toBe(join(outside, "code.ts"));
		const outsideRead = [read(join(outside, "code.ts"))];
		expect(await addNestedGuides(outsideRead, root, startup())).toEqual(outsideRead);
		await rm(join(root, "src/AGENTS.md"));
		await symlink(join(outside, "AGENTS.md"), join(root, "src/AGENTS.md"));
		let text = textOf(await addNestedGuides([read(join(root, "src/deep/code.ts"))], root, startup()));
		expect(text).not.toContain("EXTERNAL_MARKER");
		expect(text).toContain("outside project boundary");
		await writeFile(join(root, "src/.git"), "gitdir: /not-read");
		text = textOf(await addNestedGuides([read(join(root, "src/deep/code.ts"))], root, startup()));
		expect(text).not.toContain("CHILD_MARKER");
	});

	it("finds linked worktree roots and uses startup CWD outside Git", async () => {
		await rm(join(root, ".git"), { recursive: true });
		await writeFile(join(root, ".git"), "gitdir: /separate/repo/.git/worktrees/test");
		expect(await projectRoot(join(root, "src/deep"))).toBe(root);
		expect(await projectRoot(outside)).toBe(outside);
	});

	it("bounds guides and cumulative context without truncating or falling through overrides", async () => {
		await writeFile(join(root, "src/AGENTS.override.md"), "X".repeat(9000));
		const input = [read(join(root, "src/deep/code.ts"))];
		const text = textOf(await addNestedGuides(input, root, startup()));
		expect(text).toContain("8192-byte guide budget");
		expect(text).not.toContain("PARENT_MARKER");
		expect(text).not.toContain("X".repeat(100));
		const output = await addNestedGuides(input, root, startup(), {
			...DEFAULT_BUDGETS,
			context: 150,
			activation: 150,
		});
		const added =
			output[0].role === "toolResult"
				? output[0].content
						.slice(1)
						.map((block) => (block.type === "text" ? block.text : ""))
						.join("")
				: "";
		expect(Buffer.byteLength(added)).toBeLessThanOrEqual(150);
		expect(added).toContain("omitted");
	});

	it("omits binary guides and preserves image source blocks", async () => {
		await writeFile(join(root, "src/AGENTS.override.md"), Buffer.from([0, 1, 2]));
		const message = read(join(root, "src/deep/code.ts"), "image", {
			content: [{ type: "image", data: "test", mimeType: "image/png" }],
		});
		const output = await addNestedGuides([message], root, startup());
		expect(textOf(output)).toContain("binary guide");
		expect(output[0].role === "toolResult" && output[0].content[0]).toEqual({
			type: "image",
			data: "test",
			mimeType: "image/png",
		});
	});

	it("omits invalid UTF-8 rather than supplying a lossy guide", async () => {
		await writeFile(join(root, "src/AGENTS.override.md"), Buffer.from([0xff, 0xfe, 0xfd]));
		const text = textOf(await addNestedGuides([read(join(root, "src/deep/code.ts"))], root, startup()));
		expect(text).toContain("non-UTF-8 guide");
		expect(text).not.toContain("PARENT_MARKER");
	});

	it("reprojects compaction/branch/resume context and refreshes changed content without growth", async () => {
		const original = [read(join(root, "src/deep/code.ts"))];
		const a = await addNestedGuides(original, root, startup());
		expect(await addNestedGuides(original, root, startup())).toEqual(a);
		expect(await addNestedGuides([], root, startup())).toEqual([]);
		await writeFile(join(root, "src/deep/CLAUDE.md"), "REFRESHED_MARKER");
		await writeFile(join(root, "AGENTS.md"), "NEW_ROOT_MARKER");
		const resumed = JSON.parse(JSON.stringify(original)) as AgentMessage[];
		const text = textOf(await addNestedGuides(resumed, root, startup()));
		expect(text).toContain("REFRESHED_MARKER");
		expect(text).not.toContain("CHILD_MARKER");
		expect(text).toContain("startup guide changed; reload Pi");
		expect(text).not.toContain("NEW_ROOT_MARKER");
	});

	it("falls through unreadable candidates like Pi without breaking a read", async () => {
		const override = join(root, "src/AGENTS.override.md");
		await writeFile(override, "UNREADABLE_MARKER");
		await chmod(override, 0);
		try {
			const text = textOf(await addNestedGuides([read(join(root, "src/deep/code.ts"))], root, startup()));
			expect(text).toContain("PARENT_MARKER");
			expect(text).not.toContain("UNREADABLE_MARKER");
		} finally {
			await chmod(override, 0o600);
		}
	});

	it("deduplicates an explicit guide read through an in-project symlink", async () => {
		await writeFile(join(root, "rules.txt"), "ALIASED_MARKER");
		await rm(join(root, "src/AGENTS.md"));
		await symlink(join(root, "rules.txt"), join(root, "src/AGENTS.md"));
		const input = [read(join(root, "src/deep/code.ts")), read(join(root, "rules.txt"), "ALIASED_MARKER")];
		expect(textOf(await addNestedGuides(input, root, startup())).match(/ALIASED_MARKER/g)).toHaveLength(1);
	});

	it("combines the scopes of canonical guide aliases without duplicating their text", async () => {
		await writeFile(join(root, "rules.txt"), "SHARED_RULES_MARKER");
		await rm(join(root, "src/AGENTS.md"));
		await symlink(join(root, "rules.txt"), join(root, "src/AGENTS.md"));
		await mkdir(join(root, "other"));
		await writeFile(join(root, "other/code.ts"), "source");
		await symlink(join(root, "rules.txt"), join(root, "other/AGENTS.md"));
		const text = textOf(
			await addNestedGuides(
				[read(join(root, "src/deep/code.ts")), read(join(root, "other/code.ts"))],
				root,
				startup(),
			),
		);
		expect(text.match(/SHARED_RULES_MARKER/g)).toHaveLength(1);
		expect(text).toContain('scope [\\"src\\",\\"other\\"]');
	});

	it("reports notice saturation within the session budget", async () => {
		const input: AgentMessage[] = [];
		for (let index = 0; index < 50; index++) {
			const directory = join(root, `wide-${index}`);
			await mkdir(directory);
			await writeFile(join(directory, "AGENTS.md"), "X".repeat(9000));
			await writeFile(join(directory, "code.ts"), "source");
			input.push(read(join(directory, "code.ts")));
		}
		const output = await addNestedGuides(input, root, startup());
		expect(textOf(output)).toContain("notice budget exhausted");
		const bytes = output.reduce(
			(total, message) =>
				total +
				(message.role === "toolResult"
					? message.content
							.slice(1)
							.reduce((n, block) => n + (block.type === "text" ? Buffer.byteLength(block.text) : 0), 0)
					: 0),
			0,
		);
		expect(bytes).toBeLessThanOrEqual(DEFAULT_BUDGETS.context);
		expect(bytes).toBeLessThanOrEqual(DEFAULT_BUDGETS.notices);
	});

	it("matches read path prefixes, URLs, Unicode spaces and macOS fallbacks", async () => {
		const source = join(root, "src/deep/code.ts");
		expect(await resolveReadTarget("@src/deep/code.ts", root)).toBe(source);
		expect(await resolveReadTarget(`file://${source}`, outside)).toBe(source);
		await writeFile(join(root, "a b.ts"), "space");
		expect(await resolveReadTarget("a\u00a0b.ts", root)).toBe(join(root, "a b.ts"));
		await writeFile(join(root, "Capture 1\u202fPM.png"), "image");
		expect(await resolveReadTarget("Capture 1 PM.png", root)).toBe(join(root, "Capture 1\u202fPM.png"));
		await writeFile(join(root, "d’écran.ts"), "quote");
		expect(await resolveReadTarget("d'écran.ts", root)).toBe(join(root, "d’écran.ts"));
		expect(await resolveReadTarget("src", root)).toBeUndefined();
	});
});

describe("Pi event wiring", () => {
	it("is opt-in, trusted, fail-closed and preserves source result fields", async () => {
		type HookResult = { details?: unknown; content?: unknown; messages?: AgentMessage[] } | undefined;
		type Handler = (...args: unknown[]) => HookResult | Promise<HookResult>;
		const handlers = new Map<string, Handler>();
		let enabled = false;
		let trusted = true;
		const pi = {
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			registerFlag: vi.fn(),
			registerCommand: vi.fn(),
			getFlag: () => enabled,
		} as unknown as ExtensionAPI;
		const ctx = { cwd: root, isProjectTrusted: () => trusted } as ExtensionContext;
		nestedAgents(pi);
		await handlers.get("session_start")?.({}, ctx);
		handlers.get("before_agent_start")?.({ systemPromptOptions: { contextFiles: startup() } }, ctx);
		const result = {
			toolName: "read",
			input: { path: "src/deep/code.ts", offset: 2 },
			isError: false,
			details: { truncation: "kept" },
			content: [{ type: "text", text: "source" }],
		};
		const hook = handlers.get("tool_result");
		expect(await hook?.(result, ctx)).toBeUndefined();
		enabled = true;
		trusted = false;
		expect(await hook?.(result, ctx)).toBeUndefined();
		trusted = true;
		for (const contextFiles of [[], startup()]) {
			handlers.get("before_agent_start")?.({
				systemPromptOptions: { contextFiles, forceSystemPrompt: "forced" },
			});
			expect(await hook?.(result, ctx)).toBeUndefined();
		}
		handlers.get("before_agent_start")?.({ systemPromptOptions: { contextFiles: startup() } });
		const metadata = await hook?.(result, ctx);
		expect(metadata).toEqual({
			details: { truncation: "kept", [READ_SCOPE_KEY]: { root, path: join(root, "src/deep/code.ts") } },
		});
		expect(metadata?.content).toBeUndefined();
		for (const changes of [{ toolName: "bash" }, { isError: true }, { parentToolCallId: "parent" }]) {
			expect(await hook?.({ ...result, ...changes }, ctx)).toBeUndefined();
		}
		const projected = await handlers.get("context")?.(
			{ messages: [read(join(root, "src/deep/code.ts"))] },
			ctx,
		);
		expect(textOf(projected?.messages ?? [])).toContain("CHILD_MARKER");
		enabled = false;
		expect(await handlers.get("context")?.({ messages: projected?.messages }, ctx)).toBeUndefined();
		expect(await readFile(join(root, "src/deep/CLAUDE.md"), "utf8")).toBe("CHILD_MARKER");
	});
});
