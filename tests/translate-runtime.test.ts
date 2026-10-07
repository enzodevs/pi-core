import { mkdtemp, rm } from "node:fs/promises";
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
import { expect, it, vi } from "vitest";
import { LocalTranslator } from "../extensions/translate/backend.js";
import promptTranslation from "../extensions/translate/index.js";

it("sends only translated user text through the real Pi boundary; commands and extension state stay invisible", async () => {
	const root = await mkdtemp(join(tmpdir(), "pi-translate-runtime-"));
	const start = vi.spyOn(LocalTranslator.prototype, "start").mockResolvedValue();
	const stop = vi.spyOn(LocalTranslator.prototype, "stop").mockResolvedValue();
	const translate = vi
		.spyOn(LocalTranslator.prototype, "translate")
		.mockResolvedValue("Fix only the validation error.");
	try {
		const settings = SettingsManager.inMemory({ compaction: { enabled: false }, cacheWarming: "off" });
		const loader = new DefaultResourceLoader({
			cwd: root,
			agentDir: root,
			settingsManager: settings,
			extensionFactories: [promptTranslation],
			noContextFiles: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
		});
		await loader.reload();
		const runtime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			modelsStorePath: join(root, "models-cache.json"),
			refreshOnCreate: false,
		});
		const model = runtime.getModels("openai")[0];
		if (!model) throw new Error("No fixture model available");
		await runtime.setRuntimeApiKey("openai", "local-test-only");
		const { session } = await createAgentSession({
			cwd: root,
			agentDir: root,
			resourceLoader: loader,
			modelRuntime: runtime,
			model,
			settingsManager: settings,
			sessionManager: SessionManager.inMemory(root),
			tools: [],
			thinkingLevel: "off",
		});
		try {
			await session.bindExtensions({
				onError: (error) => {
					throw new Error(error.error);
				},
			});
			const requests: Context[] = [];
			session.agent.streamFunction = (_model, context) => {
				requests.push(structuredClone(context));
				const message: AssistantMessage = {
					role: "assistant",
					api: model.api,
					provider: model.provider,
					model: model.id,
					timestamp: Date.now(),
					content: [{ type: "text", text: "done" }],
					stopReason: "stop",
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
				stream.push({ type: "done", reason: "stop", message });
				stream.end(message);
				return stream;
			};
			await session.prompt("/translate on");
			await session.prompt("/translate status");
			expect(requests).toHaveLength(0);
			await session.prompt("Corrija apenas o erro de validação.");
			expect(requests).toHaveLength(1);
			const wire = JSON.stringify(requests[0]);
			expect(wire).toContain("Fix only the validation error.");
			for (const excluded of [
				"Corrija apenas",
				"/translate",
				"pi-core-translate",
				"TranslateGemma",
				"Local PT-BR",
			]) {
				expect(wire).not.toContain(excluded);
			}
			expect(requests[0]?.tools ?? []).toEqual([]);
			await session.prompt("/translate off");
			expect(requests).toHaveLength(1);
			await session.prompt("Não traduza este prompt.");
			expect(JSON.stringify(requests[1])).toContain("Não traduza este prompt.");
			expect(translate).toHaveBeenCalledTimes(1);
		} finally {
			session.dispose();
		}
	} finally {
		start.mockRestore();
		stop.mockRestore();
		translate.mockRestore();
		await rm(root, { recursive: true, force: true });
	}
});
