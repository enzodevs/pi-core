import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSessionFromServices,
	createAgentSessionServices,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import codexAccounts from "../extensions/codex-accounts/index.js";
import { AccountService, PERSONAL_PROVIDER } from "../extensions/codex-accounts/service.js";
import { AccountStore, PROVIDER } from "../extensions/codex-accounts/store.js";

describe("Codex account startup restoration", () => {
	it.each(["saved", "pi-login", "missing-account", "fresh-default"] as const)(
		"registers before Pi restores the model and binds only the saved identity (%s)",
		async (selection) => {
			const directory = await mkdtemp(join(tmpdir(), "pi-codex-startup-"));
			try {
				const store = new AccountStore(join(directory, "vault"));
				await store.add("Saved", {
					type: "oauth",
					accountId: "saved",
					access: "saved-token",
					refresh: "saved-refresh",
					expires: Date.now() + 3_600_000,
				});
				const fresh = selection === "fresh-default";
				if (fresh) await store.setDefaultAccount("saved");
				const service = new AccountService(store);
				const credentials = {
					read: vi.fn(async (provider: string) =>
						provider === PROVIDER && !fresh
							? {
									type: "oauth" as const,
									accountId: "host",
									access: "host-token",
									refresh: "host-refresh",
									expires: Date.now() + 3_600_000,
								}
							: undefined,
					),
					list: async () => (fresh ? [] : [{ providerId: PROVIDER, type: "oauth" as const }]),
					modify: vi.fn(async () => undefined),
					delete: async () => {},
				};
				const runtime = await ModelRuntime.create({
					modelsPath: null,
					refreshOnCreate: false,
					allowModelNetwork: false,
					credentials,
				});
				const model = service.provider(undefined).getModels()[0];
				if (!model) throw new Error("Missing Codex model");
				const manager = SessionManager.inMemory(directory);
				const selectedProvider = selection === "pi-login" ? PROVIDER : PERSONAL_PROVIDER;
				if (!fresh) {
					manager.appendModelChange(selectedProvider, model.id);
					manager.appendCustomEntry("codex-account-selection", {
						accountId: selection === "pi-login" ? null : selection,
						modelId: model.id,
					});
					manager.appendMessage({ role: "user", content: "Resume fixture", timestamp: Date.now() });
				}
				const settings = SettingsManager.inMemory({ defaultProvider: PROVIDER, defaultModel: model.id });
				const services = await createAgentSessionServices({
					cwd: directory,
					agentDir: join(directory, "agent"),
					modelRuntime: runtime,
					settingsManager: settings,
					resourceLoaderOptions: {
						noExtensions: true,
						noSkills: true,
						noPromptTemplates: true,
						noThemes: true,
						noContextFiles: true,
						extensionFactories: [(pi) => codexAccounts(pi, service, () => undefined)],
					},
				});
				expect(services.diagnostics).toEqual([]);
				// Catalog readiness must not authorize requests before branch restoration.
				expect(runtime.hasConfiguredAuth(PERSONAL_PROVIDER)).toBe(true);
				await expect(runtime.getAuth(PERSONAL_PROVIDER)).rejects.toThrow("Selecione uma conta");
				const { session, modelFallbackMessage } = await createAgentSessionFromServices({
					services,
					sessionManager: manager,
					sessionStartEvent: { type: "session_start", reason: "startup" },
				});
				try {
					expect(modelFallbackMessage).toBeUndefined();
					expect(session.model?.provider).toBe(selectedProvider);
					await session.bindExtensions({
						onError: (error) => {
							throw new Error(error.error);
						},
					});
					expect(session.model?.provider).toBe(selectedProvider);
					if (selection === "saved" || fresh) {
						expect((await runtime.getAuth(PERSONAL_PROVIDER))?.auth.apiKey).toBe("saved-token");
					} else if (selection === "missing-account") {
						await expect(runtime.getAuth(PERSONAL_PROVIDER)).rejects.toThrow("Não foi possível autenticar");
					} else {
						expect(runtime.getModel(PERSONAL_PROVIDER, model.id)).toBeUndefined();
					}
					expect((await runtime.getAuth(PROVIDER))?.auth.apiKey).toBe(fresh ? undefined : "host-token");
					expect(credentials.modify).not.toHaveBeenCalled();
				} finally {
					session.dispose();
				}
			} finally {
				await rm(directory, { recursive: true, force: true });
			}
		},
	);
});
