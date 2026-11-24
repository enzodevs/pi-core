import { spawn } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

async function put(file: string, content: string) {
	await mkdir(dirname(file), { recursive: true });
	await writeFile(file, content);
}

describe("real CLI resource startup (offline, no model requests)", () => {
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
					defaultTools: ["+codemode"],
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
			child = spawn(
				process.execPath,
				[
					resolve("node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
					"--mode",
					"rpc",
					"--no-session",
				],
				{
					cwd,
					env: {
						...process.env,
						HOME: root,
						PI_CODING_AGENT_DIR: agentDir,
						PI_OFFLINE: "1",
						PI_CORE_MEMORY_CONSOLIDATOR: "1",
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
				]),
			);
			expect(runtime.tools).toEqual(expect.arrayContaining(["codemode", "tool_search", "fixture_tool"]));
			for (const removed of ["background_agent", "agent_control", "ask_parent"])
				expect(runtime.tools).not.toContain(removed);
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
