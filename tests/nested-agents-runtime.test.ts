import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AssistantMessage,
	type Context,
	createAssistantMessageEventStream,
} from "@earendil-works/pi-ai";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import nestedAgents from "../extensions/nested-agents/index.js";

// Exercises the actual Pi agent/tool/provider boundary with a deterministic local stream.
// No credentials from the user's profile, external requests, model spend or child agents.
describe("nested guides through Pi 0.99.1 runtime", () => {
	it("passes positive, disabled, no-context and nested-start controls without guide reads", async () => {
		const fixture = await mkdtemp(join(tmpdir(), "nested-runtime-"));
		const root = join(fixture, "repo");
		const nested = join(root, "src");
		const marker = randomUUID();
		const parent = randomUUID();
		await mkdir(nested, { recursive: true });
		await mkdir(join(root, ".git"));
		await writeFile(join(root, "AGENTS.md"), `Root guidance ${parent}`);
		await writeFile(join(nested, "AGENTS.md"), `Nested guidance ${marker}`);
		await writeFile(join(nested, "code.ts"), "export const originalSource = 42;");
		try {
			for (const control of ["enabled", "disabled", "no-context", "nested-start"] as const) {
				const cwd = control === "nested-start" ? nested : root;
				const agentDir = join(fixture, control);
				await mkdir(agentDir);
				const settings = SettingsManager.inMemory(
					{ compaction: { enabled: false }, cacheWarming: "off" },
					{ projectTrusted: true },
				);
				const loader = new DefaultResourceLoader({
					cwd,
					agentDir,
					settingsManager: settings,
					extensionFactories: [nestedAgents],
					noContextFiles: control === "no-context",
					noSkills: true,
					noPromptTemplates: true,
					noThemes: true,
				});
				await loader.reload();
				const runtime = await ModelRuntime.create({
					authPath: join(agentDir, "auth.json"),
					modelsPath: null,
					modelsStorePath: join(agentDir, "models-cache.json"),
					refreshOnCreate: false,
				});
				const model = runtime.getModels("openai")[0];
				expect(model).toBeDefined();
				await runtime.setRuntimeApiKey("openai", "local-test-only");
				const { session } = await createAgentSession({
					cwd,
					agentDir,
					resourceLoader: loader,
					modelRuntime: runtime,
					model,
					settingsManager: settings,
					sessionManager: SessionManager.inMemory(cwd),
					tools: control === "nested-start" ? [] : ["read"],
					thinkingLevel: "off",
				});
				try {
					await session.bindExtensions({
						onError: (error) => {
							throw new Error(error.error);
						},
					});
					session.extensionRunner.setFlagValue("nested-agents", control !== "disabled");
					const requests: Context[] = [];
					const calls: string[] = [];
					session.subscribe((event) => {
						if (event.type === "tool_execution_start") calls.push(event.toolName);
					});
					session.agent.streamFunction = (_model, context) => {
						requests.push(structuredClone(context));
						const readSource = requests.length === 1 && control !== "nested-start";
						const message: AssistantMessage = {
							role: "assistant",
							api: model.api,
							provider: model.provider,
							model: model.id,
							timestamp: Date.now(),
							content: readSource
								? [{ type: "toolCall", id: "source-read", name: "read", arguments: { path: "src/code.ts" } }]
								: [{ type: "text", text: "done" }],
							stopReason: readSource ? "toolUse" : "stop",
							usage: {
								input: 0,
								output: 0,
								cacheRead: 0,
								cacheWrite: 0,
								totalTokens: 0,
								cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
							},
						};
						const stream = createAssistantMessageEventStream();
						stream.push({ type: "done", reason: readSource ? "toolUse" : "stop", message });
						stream.end(message);
						return stream;
					};
					await session.prompt(
						"Read only the source file once if tools are available. Do not read guides, search or guess markers.",
					);
					const first = JSON.stringify(requests[0]);
					const last = JSON.stringify(requests.at(-1));
					if (control === "nested-start") {
						expect(first).toContain(marker);
						expect(calls).toEqual([]);
					} else {
						expect(first).not.toContain(marker);
						expect(calls).toEqual(["read"]);
						expect(last).toContain("export const originalSource = 42;");
						if (control === "enabled") {
							expect(last).toContain(marker);
							expect(last.match(new RegExp(marker, "g"))).toHaveLength(1);
							const projectedRead = requests
								.at(-1)
								?.messages.find((message) => message.role === "toolResult");
							const addedBytes =
								projectedRead?.role === "toolResult"
									? projectedRead.content
											.slice(1)
											.reduce(
												(n, block) => n + (block.type === "text" ? Buffer.byteLength(block.text) : 0),
												0,
											)
									: 0;
							expect(addedBytes).toBeGreaterThan(0);
							expect(addedBytes).toBeLessThanOrEqual(16384);
							console.info(
								`Nested runtime control: ${addedBytes} added UTF-8 bytes; 1 source read, 0 guide reads`,
							);
							await session.prompt("Reply done without using tools.");
							expect(JSON.stringify(requests.at(-1)).match(new RegExp(marker, "g"))).toHaveLength(1);
							expect(calls).toEqual(["read"]);
							// Ephemeral guides must not leak into stored context/compaction inputs.
							expect(JSON.stringify(session.sessionManager.getBranch())).not.toContain(marker);
						} else expect(last).not.toContain(marker);
					}
				} finally {
					session.dispose();
				}
			}
		} finally {
			await rm(fixture, { recursive: true, force: true });
		}
	}, 30000);
});
