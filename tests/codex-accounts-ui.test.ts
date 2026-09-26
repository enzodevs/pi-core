import type { Api, Model, ModelsRefreshOptions, ModelsRefreshResult } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import codexAccounts from "../extensions/codex-accounts/index.js";
import type { PiAccount } from "../extensions/codex-accounts/pi-account.js";
import { AccountService, PERSONAL_PROVIDER } from "../extensions/codex-accounts/service.js";
import type { AccountStore } from "../extensions/codex-accounts/store.js";

function harness() {
	const accounts = [
		{ id: "one", label: "Personal" },
		{ id: "two", label: "Work" },
	];
	const piLabels = new Map<string, string>();
	const store = {
		list: vi.fn(async () => accounts),
		remove: vi.fn(async () => {}),
		piLabel: vi.fn(async (id: string) => piLabels.get(id)),
		rename: vi.fn(async (id: string, label: string, source: "pi" | "vault") => {
			if (source === "pi") piLabels.set(id, label);
			else {
				const account = accounts.find((a) => a.id === id);
				if (account) account.label = label;
			}
		}),
	};
	const service = new AccountService(store as unknown as AccountStore);
	const pi = {
		registerCommand: vi.fn(),
		registerShortcut: vi.fn(),
		registerProvider: vi.fn(),
		unregisterProvider: vi.fn(),
		appendEntry: vi.fn(),
		setModel: vi.fn(async (_model: Model<Api>) => true),
		on: vi.fn(),
	};
	const getPiAccount = vi.fn((): PiAccount | undefined => undefined);
	codexAccounts(pi as unknown as ExtensionAPI, service, getPiAccount);
	const baseModel = openaiCodexProvider().getModels()[0];
	if (!baseModel) throw new Error("Missing model");
	const ctx = {
		hasUI: true,
		isIdle: vi.fn(() => true),
		model: baseModel as Model<Api>,
		ui: {
			select: vi.fn(),
			input: vi.fn(),
			notify: vi.fn(),
			confirm: vi.fn(async () => true),
			custom: vi.fn(async () => undefined),
		},
		modelRegistry: {
			find: vi.fn(() => baseModel),
			refresh: vi.fn(
				async (_options?: ModelsRefreshOptions): Promise<ModelsRefreshResult> => ({
					aborted: false,
					errors: new Map<string, Error>(),
				}),
			),
		},
		sessionManager: { getBranch: vi.fn((): unknown[] => []) },
	};
	const open = () => pi.registerCommand.mock.calls[0]?.[1].handler("", ctx as unknown as ExtensionContext);
	const start = () => pi.on.mock.calls[0]?.[1]({}, ctx as unknown as ExtensionContext);
	return { pi, ctx, store, open, start, baseModel, getPiAccount };
}

describe("Codex TUI wiring", () => {
	it.each(["switch", "restore"] as const)(
		"awaits the real Pi auth snapshot before model selection (%s)",
		async (operation) => {
			const { ctx, pi, open, start, baseModel } = harness();
			const runtime = await ModelRuntime.create({
				modelsPath: null,
				refreshOnCreate: false,
				allowModelNetwork: false,
				credentials: {
					read: async () => undefined,
					list: async () => [],
					modify: async () => undefined,
					delete: async () => {},
				},
			});
			const registry = new ModelRegistry(runtime);
			const immediatelyConfigured: boolean[] = [];
			pi.registerProvider.mockImplementation((provider) => {
				runtime.registerNativeProvider(provider);
				immediatelyConfigured.push(runtime.hasConfiguredAuth(PERSONAL_PROVIDER));
			});
			pi.unregisterProvider.mockImplementation((id) => runtime.unregisterProvider(id));
			ctx.modelRegistry.refresh.mockImplementation((options) => registry.refresh(options));
			// This is Pi's ExtensionAPI.setModel gate: it reads the cached snapshot
			// before AgentSession.setModel can perform its async auth check.
			pi.setModel.mockImplementation(async (model) => {
				if (!runtime.hasConfiguredAuth(model.provider)) return false;
				expect(await runtime.checkAuth(model.provider)).toBeDefined();
				ctx.model = model;
				return true;
			});
			if (operation === "switch") {
				ctx.ui.select
					.mockImplementationOnce(async (_title, rows) => rows[1])
					.mockResolvedValueOnce("Usar nesta sessão")
					.mockResolvedValueOnce(undefined);
				await open();
			} else {
				ctx.sessionManager.getBranch.mockReturnValue([
					{
						type: "custom",
						customType: "codex-account-selection",
						data: { accountId: "two", modelId: baseModel.id },
					},
				]);
				await start();
			}
			expect(immediatelyConfigured).toEqual([false]);
			expect(ctx.modelRegistry.refresh).toHaveBeenCalledWith(
				expect.objectContaining({ providers: [PERSONAL_PROVIDER], allowNetwork: false }),
			);
			expect(ctx.model.provider).toBe(PERSONAL_PROVIDER);
			expect(pi.setModel).toHaveResolvedWith(true);
			if (operation === "switch")
				expect(pi.appendEntry).toHaveBeenCalledWith("codex-account-selection", {
					accountId: "two",
					modelId: baseModel.id,
				});
		},
	);
	it.each(["aborted", "error"])(
		"does not select or persist an account when readiness refresh fails (%s)",
		async (failure) => {
			const { ctx, pi, open } = harness();
			ctx.modelRegistry.refresh.mockResolvedValue({
				aborted: failure === "aborted",
				errors:
					failure === "error" ? new Map([[PERSONAL_PROVIDER, new Error("SECRET_SERVER_BODY")]]) : new Map(),
			});
			ctx.ui.select
				.mockImplementationOnce(async (_title, rows) => rows[0])
				.mockResolvedValueOnce("Usar nesta sessão")
				.mockResolvedValueOnce(undefined);
			await open();
			expect(pi.setModel).not.toHaveBeenCalled();
			expect(pi.appendEntry).not.toHaveBeenCalled();
			expect(pi.unregisterProvider).toHaveBeenCalledWith(PERSONAL_PROVIDER);
			expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain("SECRET_SERVER_BODY");
		},
	);
	it.each(["pi", "vault"] as const)(
		"renames a %s account in place without changing auth/model",
		async (source) => {
			const { ctx, pi, store, open, getPiAccount } = harness();
			if (source === "pi")
				getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
			ctx.ui.select
				.mockImplementationOnce(async (_title, rows) => rows[0])
				.mockResolvedValueOnce("Renomear conta")
				.mockResolvedValueOnce(undefined);
			ctx.ui.input.mockResolvedValue(" Admin Redapro ");
			await open();
			expect(store.rename).toHaveBeenCalledWith(
				source === "pi" ? "existing" : "one",
				"Admin Redapro",
				source,
			);
			expect(ctx.ui.select.mock.calls[2]?.[1][0]).toContain("Admin Redapro");
			if (source === "pi") expect(ctx.ui.select.mock.calls[2]?.[1][0]).toContain("● Admin Redapro (ativa)");
			expect(pi.setModel).not.toHaveBeenCalled();
			expect(pi.appendEntry).not.toHaveBeenCalled();
		},
	);
	it.each([undefined, "", "\u001b[31m", "x".repeat(61)])(
		"does not persist a cancelled or invalid rename (%s)",
		async (label) => {
			const { ctx, store, open } = harness();
			ctx.ui.select
				.mockImplementationOnce(async (_title, rows) => rows[0])
				.mockResolvedValueOnce("Renomear conta")
				.mockResolvedValueOnce(undefined);
			ctx.ui.input.mockResolvedValue(label);
			await open();
			expect(store.rename).not.toHaveBeenCalled();
		},
	);
	it("automatically lists the existing Pi login as active even with an empty vault", async () => {
		const { ctx, pi, store, open, getPiAccount } = harness();
		store.list.mockResolvedValue([]);
		getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
		await open();
		expect(ctx.ui.select.mock.calls[0]?.[1][0]).toContain("● Login padrão do Pi (ativa)");
		expect(pi.registerProvider).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(store.remove).not.toHaveBeenCalled();
	});
	it("marks the default login inactive on another provider and lets the user switch back without copying tokens", async () => {
		const { ctx, pi, open, getPiAccount, baseModel, store } = harness();
		getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
		ctx.model = { ...baseModel, provider: PERSONAL_PROVIDER };
		ctx.ui.select
			.mockImplementationOnce(async (_title, rows) => rows[0])
			.mockResolvedValueOnce("Usar nesta sessão");
		await open();
		expect(ctx.ui.select.mock.calls[0]?.[1][0]).toContain("○ Login padrão do Pi");
		expect(ctx.ui.select.mock.calls[1]?.[1]).toEqual(["Usar nesta sessão", "Renomear conta"]);
		expect(pi.setModel).toHaveBeenCalledWith(baseModel);
		expect(pi.appendEntry).toHaveBeenCalledWith("codex-account-selection", { accountId: null });
		expect(pi.registerProvider).not.toHaveBeenCalled();
		expect(store.remove).not.toHaveBeenCalled();
	});
	it("does not mark a saved selection active when the current model uses the default login", async () => {
		const { ctx, pi, open, start, getPiAccount, baseModel } = harness();
		getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
		ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "custom",
				customType: "codex-account-selection",
				data: { accountId: "one", modelId: baseModel.id },
			},
		]);
		await start();
		pi.setModel.mockClear();
		await open();
		expect(ctx.ui.select.mock.calls[0]?.[1][0]).toContain("● Login padrão do Pi (ativa)");
		expect(ctx.ui.select.mock.calls[0]?.[1][1]).toContain("○ Personal");
	});
	it("refuses to select a different default identity if auth.json changes while the menu is open", async () => {
		const { ctx, pi, open, getPiAccount } = harness();
		getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
		ctx.ui.select
			.mockImplementationOnce(async (_title, rows) => rows[0])
			.mockImplementationOnce(async () => {
				getPiAccount.mockReturnValue({ id: "changed", label: "Login padrão do Pi", source: "pi" });
				return "Usar nesta sessão";
			})
			.mockResolvedValueOnce(undefined);
		await open();
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("login padrão mudou"), "warning");
	});
	it("excludes selection metadata from Pi's actual model context builder", () => {
		const context = buildSessionContext([
			{
				type: "custom",
				id: "selection",
				parentId: null,
				timestamp: new Date().toISOString(),
				customType: "codex-account-selection",
				data: { accountId: "private-account", modelId: "gpt-5.4" },
			},
		]);
		expect(context.messages).toEqual([]);
		expect(JSON.stringify(context)).not.toContain("private-account");
	});
	it("blocks mutation while streaming and is inert without UI", async () => {
		const { ctx, open, store } = harness();
		ctx.isIdle.mockReturnValue(false);
		await open();
		expect(store.list).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalled();
		ctx.hasUI = false;
		ctx.isIdle.mockReturnValue(true);
		await open();
		expect(store.list).not.toHaveBeenCalled();
	});
	it("switches only the session provider and stores no tokens in session state", async () => {
		const { ctx, pi, open } = harness();
		ctx.ui.select
			.mockImplementationOnce(async (_title, rows) => rows[1])
			.mockResolvedValueOnce("Usar nesta sessão");
		await open();
		expect(pi.registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: PERSONAL_PROVIDER }));
		expect(pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: PERSONAL_PROVIDER }));
		expect(pi.appendEntry).toHaveBeenCalledWith("codex-account-selection", {
			accountId: "two",
			modelId: ctx.model.id,
		});
	});
	it("rolls back provider registration if model switching fails", async () => {
		const { ctx, pi, open } = harness();
		ctx.ui.select
			.mockImplementationOnce(async (_title, rows) => rows[0])
			.mockResolvedValueOnce("Usar nesta sessão")
			.mockResolvedValueOnce(undefined);
		pi.setModel.mockResolvedValue(false);
		await open();
		expect(pi.unregisterProvider).toHaveBeenCalledWith(PERSONAL_PROVIDER);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
	it("requires confirmation before removal", async () => {
		const { ctx, store, open } = harness();
		ctx.ui.select
			.mockImplementationOnce(async (_title, rows) => rows[0])
			.mockResolvedValueOnce("Remover conta")
			.mockResolvedValueOnce(undefined);
		ctx.ui.confirm.mockResolvedValue(false);
		await open();
		expect(store.remove).not.toHaveBeenCalled();
	});
	it("restores selected identity after reload and clears it on switching sessions", async () => {
		const { ctx, pi, start, baseModel } = harness();
		ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "custom",
				customType: "codex-account-selection",
				data: { accountId: "two", modelId: baseModel.id },
			},
		]);
		await start();
		expect(pi.registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: PERSONAL_PROVIDER }));
		expect(pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: PERSONAL_PROVIDER }));
		ctx.sessionManager.getBranch.mockReturnValue([]);
		ctx.model = { ...baseModel, provider: PERSONAL_PROVIDER };
		await start();
		expect(pi.unregisterProvider).toHaveBeenCalledWith(PERSONAL_PROVIDER);
		expect(pi.setModel).toHaveBeenLastCalledWith(baseModel);
	});
});
