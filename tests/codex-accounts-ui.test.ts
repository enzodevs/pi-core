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
import { type AccountAction, showAccountPanel } from "../extensions/codex-accounts/panel.js";
import type { PiAccount } from "../extensions/codex-accounts/pi-account.js";
import { AccountService, PERSONAL_PROVIDER } from "../extensions/codex-accounts/service.js";
import type { AccountStore } from "../extensions/codex-accounts/store.js";

vi.mock("../extensions/codex-accounts/panel.js", () => ({ showAccountPanel: vi.fn() }));
vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => ({
	...(await importOriginal<typeof import("@earendil-works/pi-coding-agent")>()),
	BorderedLoader: class {
		onAbort?: () => void;
		dispose() {}
	},
}));

function harness() {
	const accounts = [
		{ id: "one", label: "Personal" },
		{ id: "two", label: "Work" },
	];
	const piLabels = new Map<string, string>();
	const store = {
		defaultAccount: vi.fn(async (): Promise<string | undefined> => undefined),
		setDefaultAccount: vi.fn(async (_id: string | undefined) => {}),
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
			custom: vi.fn(async (_factory: Parameters<ExtensionContext["ui"]["custom"]>[0]) => undefined),
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
		sessionManager: {
			getBranch: vi.fn((): unknown[] => []),
			getSessionFile: vi.fn((): string | undefined => undefined),
		},
	};
	const panel = vi.mocked(showAccountPanel).mockReset().mockResolvedValue(undefined);
	const choose = (action: AccountAction, index = 0) =>
		panel.mockImplementationOnce(async (_ctx, state) => ({ action, accountKey: state.accounts[index]?.key }));
	const open = () => pi.registerCommand.mock.calls[0]?.[1].handler("", ctx as unknown as ExtensionContext);
	const start = (reason = "reload") =>
		pi.on.mock.calls.find(([event]) => event === "session_start")?.[1](
			{ reason },
			ctx as unknown as ExtensionContext,
		);
	const input = () =>
		pi.on.mock.calls.find(([event]) => event === "input")?.[1]({}, ctx as unknown as ExtensionContext);
	const saved = (id = "two") =>
		ctx.sessionManager.getBranch.mockReturnValue([
			{
				type: "custom",
				customType: "codex-account-selection",
				data: { accountId: id, modelId: baseModel.id },
			},
		]);
	const loadUsage = (availableResets: number) => {
		vi.spyOn(service, "usage").mockResolvedValue({ windows: [], checkedAt: 1, availableResets });
		ctx.ui.custom.mockImplementation(async (factory) => {
			await new Promise<void>((resolve) => {
				factory({} as never, {} as never, {} as never, () => resolve());
			});
			return undefined;
		});
	};
	return {
		pi,
		ctx,
		store,
		service,
		open,
		start,
		input,
		saved,
		baseModel,
		getPiAccount,
		panel,
		choose,
		loadUsage,
	};
}

describe("Codex dashboard wiring", () => {
	it("opens with the active saved account first and browsing has no side effects", async () => {
		const { ctx, pi, start, open, saved, panel, baseModel } = harness();
		saved();
		await start();
		ctx.model = { ...baseModel, provider: PERSONAL_PROVIDER };
		pi.setModel.mockClear();
		await open();
		expect(panel.mock.calls[0]?.[1].accounts[0]).toMatchObject({ key: "vault:two", active: true });
		expect(pi.setModel).not.toHaveBeenCalled();
	});

	it.each([false, true])("requires confirmation before reset (confirmed=%s)", async (confirmed) => {
		const { ctx, service, open, pi, choose, loadUsage } = harness();
		loadUsage(1);
		const reset = vi.spyOn(service, "reset").mockResolvedValue("reset");
		ctx.ui.confirm.mockResolvedValue(confirmed);
		choose("reset");
		await open();
		expect(reset).toHaveBeenCalledTimes(confirmed ? 1 : 0);
		if (confirmed) expect(reset).toHaveBeenCalledWith("one", expect.any(AbortSignal));
		expect(pi.setModel).not.toHaveBeenCalled();
	});
	it("rejects reset actions when credits are unavailable", async () => {
		const { choose, open, service, ctx } = harness();
		const reset = vi.spyOn(service, "reset");
		choose("reset");
		await open();
		expect(reset).not.toHaveBeenCalled();
		expect(ctx.ui.confirm).not.toHaveBeenCalled();
	});
	it("saves and clears defaults without switching, retaining the focused tab", async () => {
		const { ctx, pi, store, open, choose, panel } = harness();
		choose("default", 1);
		await open();
		expect(store.setDefaultAccount).toHaveBeenCalledWith("two");
		expect(panel.mock.calls[1]?.[1].focusKey).toBe("vault:two");
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		store.defaultAccount.mockResolvedValue("two");
		choose("clear-default");
		await open();
		expect(store.setDefaultAccount).toHaveBeenCalledWith(undefined);
		expect(panel.mock.calls[2]?.[1].accounts[1]?.isDefault).toBe(true);
		expect(ctx.ui.notify).toHaveBeenCalled();
	});
	it.each(["new", "startup"])("pins the default for a fresh %s session", async (reason) => {
		const { store, start, pi, baseModel } = harness();
		store.defaultAccount.mockResolvedValue("two");
		await start(reason);
		expect(pi.appendEntry).toHaveBeenCalledWith("codex-account-selection", {
			accountId: "two",
			modelId: baseModel.id,
		});
		expect(pi.setModel).toHaveBeenCalledWith(
			expect.objectContaining({ id: baseModel.id, provider: PERSONAL_PROVIDER }),
		);
	});
	it.each(["read", "refresh", "select"])(
		"blocks failed default activation at %s until explicitly resolved",
		async (failure) => {
			const { store, start, pi, ctx, open, input, choose } = harness();
			store.defaultAccount.mockResolvedValue("two");
			if (failure === "read") store.defaultAccount.mockRejectedValueOnce(new Error("unreadable"));
			if (failure === "refresh") ctx.modelRegistry.refresh.mockRejectedValueOnce(new Error("failed"));
			if (failure === "select") pi.setModel.mockResolvedValueOnce(false);
			await start("startup");
			expect(input()).toEqual({ action: "handled" });
			const codex = ctx.model;
			ctx.model = { ...codex, provider: "anthropic" };
			expect(input()).toEqual({ action: "continue" });
			ctx.model = codex;
			choose("pi-login");
			await open();
			expect(input()).toEqual({ action: "continue" });
		},
	);
	it("retains an unresolved default-read failure on reload", async () => {
		const { start, ctx, input } = harness();
		ctx.sessionManager.getBranch.mockReturnValue([
			{ type: "custom", customType: "codex-account-selection", data: { defaultUnavailable: true } },
		]);
		await start();
		expect(input()).toEqual({ action: "handled" });
	});
	it.each(["reload", "resume", "fork"])("does not apply defaults on %s", async (reason) => {
		const { store, start, pi } = harness();
		store.defaultAccount.mockResolvedValue("two");
		await start(reason);
		expect(store.defaultAccount).not.toHaveBeenCalled();
		expect(pi.setModel).not.toHaveBeenCalled();
	});
	it("leaves persisted startup sessions and other providers alone", async () => {
		const { store, start, ctx, pi } = harness();
		store.defaultAccount.mockResolvedValue("two");
		ctx.sessionManager.getSessionFile.mockReturnValue(import.meta.filename);
		await start("startup");
		ctx.model = { ...ctx.model, provider: "anthropic" };
		await start("new");
		expect(store.defaultAccount).not.toHaveBeenCalled();
		expect(pi.setModel).not.toHaveBeenCalled();
	});
	it("restores saved choices instead of the default", async () => {
		const { store, start, pi, saved } = harness();
		store.defaultAccount.mockResolvedValue("two");
		saved("one");
		await start("startup");
		expect(store.defaultAccount).not.toHaveBeenCalled();
		expect(pi.setModel).toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});

	it.each(["switch", "restore"] as const)(
		"awaits the real Pi auth snapshot before model selection (%s)",
		async (operation) => {
			const { ctx, pi, open, start, choose, saved, baseModel } = harness();
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
			pi.setModel.mockImplementation(async (model) => {
				if (!runtime.hasConfiguredAuth(model.provider)) return false;
				expect(await runtime.checkAuth(model.provider)).toBeDefined();
				ctx.model = model;
				return true;
			});
			if (operation === "switch") {
				choose("activate", 1);
				await open();
			} else {
				saved();
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
		"does not select or persist an account when readiness fails (%s)",
		async (failure) => {
			const { ctx, pi, open, choose } = harness();
			ctx.modelRegistry.refresh.mockResolvedValue({
				aborted: failure === "aborted",
				errors:
					failure === "error" ? new Map([[PERSONAL_PROVIDER, new Error("SECRET_SERVER_BODY")]]) : new Map(),
			});
			choose("activate");
			await open();
			expect(pi.setModel).not.toHaveBeenCalled();
			expect(pi.appendEntry).not.toHaveBeenCalled();
			expect(pi.unregisterProvider).toHaveBeenCalledWith(PERSONAL_PROVIDER);
			expect(JSON.stringify(ctx.ui.notify.mock.calls)).not.toContain("SECRET_SERVER_BODY");
		},
	);
	it.each(["pi", "vault"] as const)("renames a %s account without changing auth/model", async (source) => {
		const { ctx, pi, store, open, getPiAccount, choose, panel } = harness();
		if (source === "pi")
			getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
		choose("rename");
		ctx.ui.input.mockResolvedValue(" Admin Redapro ");
		await open();
		expect(store.rename).toHaveBeenCalledWith(source === "pi" ? "existing" : "one", "Admin Redapro", source);
		expect(panel.mock.calls[1]?.[1].accounts[0]?.label).toBe("Admin Redapro");
		expect(panel.mock.calls[1]?.[1].focusKey).toBe(source === "pi" ? "pi:existing" : "vault:one");
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
	it.each([undefined, "", "\u001b[31m", "x".repeat(61)])(
		"does not persist a cancelled or invalid rename (%s)",
		async (label) => {
			const { ctx, store, open, choose } = harness();
			choose("rename");
			ctx.ui.input.mockResolvedValue(label);
			await open();
			expect(store.rename).not.toHaveBeenCalled();
		},
	);
	it("lists the existing Pi login as active with an empty vault", async () => {
		const { pi, store, open, getPiAccount, panel } = harness();
		store.list.mockResolvedValue([]);
		getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
		await open();
		expect(panel.mock.calls[0]?.[1].accounts).toEqual([
			expect.objectContaining({ key: "pi:existing", active: true }),
		]);
		expect(pi.registerProvider).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(store.remove).not.toHaveBeenCalled();
	});
	it("switches back to Pi login without copying tokens", async () => {
		const { ctx, pi, open, getPiAccount, baseModel, store, choose, panel } = harness();
		getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
		ctx.model = { ...baseModel, provider: PERSONAL_PROVIDER };
		choose("activate");
		await open();
		expect(panel.mock.calls[0]?.[1].accounts[0]?.active).toBe(false);
		expect(pi.setModel).toHaveBeenCalledWith(baseModel);
		expect(pi.appendEntry).toHaveBeenCalledWith("codex-account-selection", { accountId: null });
		expect(pi.registerProvider).not.toHaveBeenCalled();
		expect(store.remove).not.toHaveBeenCalled();
	});
	it("marks only the Pi login active when the current model uses normal auth", async () => {
		const { open, start, getPiAccount, saved, panel } = harness();
		getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
		saved("one");
		await start();
		await open();
		expect(panel.mock.calls[0]?.[1].accounts.map((a) => a.active)).toEqual([true, false, false]);
	});
	it("refuses a Pi identity changed while the panel was open", async () => {
		const { ctx, pi, open, getPiAccount, panel } = harness();
		getPiAccount.mockReturnValue({ id: "existing", label: "Login padrão do Pi", source: "pi" });
		panel.mockImplementationOnce(async (_ctx, state) => {
			getPiAccount.mockReturnValue({ id: "changed", label: "Login padrão do Pi", source: "pi" });
			return { action: "activate", accountKey: state.accounts[0]?.key };
		});
		await open();
		expect(pi.setModel).not.toHaveBeenCalled();
		expect(pi.appendEntry).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith(expect.stringContaining("login padrão mudou"), "warning");
	});
	it("excludes selection metadata from actual model context", () => {
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
		const { ctx, open, store, panel } = harness();
		ctx.isIdle.mockReturnValue(false);
		await open();
		expect(store.list).not.toHaveBeenCalled();
		expect(panel).not.toHaveBeenCalled();
		ctx.hasUI = false;
		ctx.isIdle.mockReturnValue(true);
		await open();
		expect(store.list).not.toHaveBeenCalled();
	});
	it("switches only this session and stores no tokens", async () => {
		const { ctx, pi, open, choose } = harness();
		choose("activate", 1);
		await open();
		expect(pi.registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: PERSONAL_PROVIDER }));
		expect(pi.setModel).toHaveBeenCalledWith(expect.objectContaining({ provider: PERSONAL_PROVIDER }));
		expect(pi.appendEntry).toHaveBeenCalledWith("codex-account-selection", {
			accountId: "two",
			modelId: ctx.model.id,
		});
	});
	it("rolls back registration if switching fails", async () => {
		const { pi, open, choose } = harness();
		choose("activate");
		pi.setModel.mockResolvedValue(false);
		await open();
		expect(pi.unregisterProvider).toHaveBeenCalledWith(PERSONAL_PROVIDER);
		expect(pi.appendEntry).not.toHaveBeenCalled();
	});
	it("requires confirmation before removal", async () => {
		const { ctx, store, open, choose } = harness();
		choose("remove");
		ctx.ui.confirm.mockResolvedValue(false);
		await open();
		expect(store.remove).not.toHaveBeenCalled();
	});
	it("restores selected identity and clears it on switching sessions", async () => {
		const { ctx, pi, start, baseModel, saved } = harness();
		saved();
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
