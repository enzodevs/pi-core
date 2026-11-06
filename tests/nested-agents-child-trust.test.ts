import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import nestedAgents from "../extensions/nested-agents/index.js";

type Handler = (event: unknown, ctx: ExtensionContext) => unknown;

async function readIsScoped(saved: boolean | undefined, child: boolean): Promise<boolean> {
	const base = realpathSync(mkdtempSync(join(tmpdir(), "nested-child-trust-")));
	try {
		const project = join(base, "project");
		const agentDir = join(base, "agent");
		mkdirSync(project);
		mkdirSync(agentDir);
		writeFileSync(join(project, "file.txt"), "hello");
		if (saved !== undefined)
			writeFileSync(join(agentDir, "trust.json"), JSON.stringify({ [project]: saved }));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_CORE_SUBAGENT_CONTEXT", child ? "lineage" : "");
		const handlers = new Map<string, Handler>();
		const pi = {
			on: (name: string, handler: Handler) => handlers.set(name, handler),
			registerFlag: vi.fn(),
			registerCommand: vi.fn(),
			getFlag: () => true,
		} as unknown as ExtensionAPI;
		const ctx = { cwd: project, isProjectTrusted: () => false } as unknown as ExtensionContext;
		nestedAgents(pi);
		await handlers.get("session_start")?.({}, ctx);
		handlers.get("before_agent_start")?.(
			{ systemPromptOptions: { contextFiles: [{ path: join(project, "AGENTS.md"), content: "root" }] } },
			ctx,
		);
		const result = await handlers.get("tool_result")?.(
			{
				toolName: "read",
				input: { path: "file.txt" },
				isError: false,
				details: {},
				content: [{ type: "text", text: "hello" }],
			},
			ctx,
		);
		return result !== undefined;
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
}

describe("nested guides under --no-approve", () => {
	afterEach(() => vi.unstubAllEnvs());

	it("applies to a subagent only with a saved trust decision", async () => {
		expect(await readIsScoped(true, true)).toBe(true);
		expect(await readIsScoped(false, true)).toBe(false);
		expect(await readIsScoped(undefined, true)).toBe(false);
	});

	it("does not let saved trust override a non-subagent --no-approve", async () => {
		expect(await readIsScoped(true, false)).toBe(false);
	});
});
