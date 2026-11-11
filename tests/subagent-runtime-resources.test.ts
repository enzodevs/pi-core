import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { discoverAgents } from "../extensions/subagent/agents.js";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.js";
import { createChildLineage, encodeChildLineage } from "../extensions/subagent/protocol.js";
import { buildChildArgs } from "../extensions/subagent/runner.js";

async function put(file: string, content: string) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, content);
}

describe("real CLI child resource startup (offline, no model requests)", () => {
	it("loads normal package/project extensions, skills, templates and built-ins without conflicts", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-child-resources-"));
		let child: ReturnType<typeof spawn> | undefined;
		try {
			const cwd = join(root, "worktree");
			const agentDir = join(root, "agent");
			await put(
				join(agentDir, "settings.json"),
				JSON.stringify({
					packages: [resolve(".")],
					defaultProjectTrust: "always",
					enableInstallTelemetry: false,
				}),
			);
			await put(join(cwd, ".pi/settings.json"), JSON.stringify({ codemode: { mode: "only" } }));
			await put(
				join(cwd, ".pi/skills/fixture/SKILL.md"),
				"---\nname: fixture\ndescription: Local fixture skill\n---\nFixture instructions.\n",
			);
			await put(
				join(cwd, ".pi/prompts/fixture-prompt.md"),
				"---\ndescription: Local fixture prompt\n---\nFixture prompt.\n",
			);
			await put(
				join(cwd, ".pi/extensions/fixture.ts"),
				`
				export default function(pi) {
					pi.registerTool({ name: "fixture_tool", label: "Fixture", description: "Local fixture",
						parameters: { type: "object", properties: {} },
						async execute() { return { content: [{ type: "text", text: "fixture" }] }; } });
					pi.registerCommand("fixture-runtime", { description: "Inspect local runtime", handler: async (_args, ctx) => {
						ctx.ui.notify("RUNTIME:" + JSON.stringify({ trusted: ctx.isProjectTrusted(),
							tools: pi.getAllTools().map(t => t.name), active: pi.getActiveTools(),
							commands: pi.getCommands().map(c => c.name), codemode: pi.getSettings().codemode }));
					} });
				}
			`,
			);
			const lineage = createChildLineage({
				parent: null,
				runId: "11111111",
				agent: "worker",
				allowedChildren: ["reviewer"],
				limits: DEFAULT_SUBAGENT_LIMITS,
				registryPath: join(root, "concurrency.json"),
			});
			const agent = discoverAgents(cwd, "project").agents.find((a) => a.name === "worker");
			if (!agent) throw new Error("Missing bundled worker");
			expect(agent.tools).toBeUndefined();
			await put(join(root, "system.md"), "Offline runtime fixture.");
			const args = buildChildArgs(
				{
					agent,
					lineage,
					ctx: { model: undefined } as unknown as ExtensionContext,
					parentTools: ["grep", "find", "ls"],
				},
				join(root, "system.md"),
			);
			child = spawn(
				process.execPath,
				[resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"), ...args],
				{
					cwd,
					env: {
						...process.env,
						HOME: root,
						PI_CODING_AGENT_DIR: agentDir,
						PI_OFFLINE: "1",
						PI_CORE_MEMORY_CONSOLIDATOR: "1",
						PI_CORE_SUBAGENT_CONTEXT: encodeChildLineage(lineage),
						PI_CORE_SUBAGENT_CHANNEL: "",
						PI_CORE_SUBAGENT_CHANNEL_TOKEN: "",
					},
					stdio: ["pipe", "pipe", "pipe"],
					signal: AbortSignal.timeout(20_000),
				},
			);
			const proc = child;
			let output = "";
			let errors = "";
			const snapshot = new Promise<{
				trusted: boolean;
				tools: string[];
				active: string[];
				commands: string[];
				codemode: { mode: string };
			}>((resolveSnapshot, reject) => {
				proc.on("error", reject);
				proc.on("exit", (code) => reject(new Error(`Child exited ${code}: ${errors}\n${output}`)));
				proc.stderr?.on("data", (chunk) => {
					errors = (errors + chunk).slice(-64_000);
				});
				proc.stdout?.on("data", (chunk) => {
					output += chunk;
					const lines = output.split("\n");
					output = lines.pop() ?? "";
					for (const line of lines) {
						let event: Record<string, unknown>;
						try {
							event = JSON.parse(line);
						} catch {
							continue;
						}
						if (event.type === "response" && event.success === false)
							reject(new Error(JSON.stringify(event)));
						if (
							event.type === "extension_ui_request" &&
							event.method === "notify" &&
							typeof event.message === "string" &&
							event.message.startsWith("RUNTIME:")
						) {
							resolveSnapshot(JSON.parse(event.message.slice("RUNTIME:".length)));
						}
					}
				});
			});
			proc.stdin?.write(`${JSON.stringify({ id: "probe", type: "prompt", message: "/fixture-runtime" })}\n`);
			const runtime = await snapshot;
			expect(runtime.trusted).toBe(true);
			expect(runtime.codemode.mode).toBe("only");
			expect(runtime.active).toEqual(
				expect.arrayContaining([
					"fixture_tool",
					"background_process",
					"process_control",
					"session_cwd",
					"search_skills",
					"load_skill",
					"codemode",
					"ask_parent",
					"grep",
					"find",
					"ls",
				]),
			);
			expect(runtime.tools).toEqual(expect.arrayContaining(["codemode", "tool_search", "fixture_tool"]));
			expect(runtime.tools.filter((name) => name === "codemode")).toHaveLength(1);
			expect(runtime.commands).toEqual(expect.arrayContaining(["skill:fixture", "fixture-prompt", "mcp"]));
			expect(errors).not.toMatch(/conflict|duplicate|Failed to load extension/i);
		} finally {
			if (child && child.exitCode === null && child.signalCode === null) {
				const exited = new Promise<void>((done) => child?.once("exit", () => done()));
				child.kill("SIGTERM");
				await exited;
			}
			await rm(root, { recursive: true, force: true });
		}
	}, 30_000);
});
