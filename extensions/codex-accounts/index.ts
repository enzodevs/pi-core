import { homedir } from "node:os";
import { join } from "node:path";
import type { AuthInteraction } from "@earendil-works/pi-ai";
import { BorderedLoader, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { fetchPiAccountUsage, type PiAccount, readPiAccount } from "./pi-account.js";
import { AccountService, PERSONAL_PROVIDER } from "./service.js";
import { AccountStore, normalizeLabel, PROVIDER } from "./store.js";
import { type Usage, usageSummary } from "./usage.js";

function interaction(ctx: ExtensionContext, controller: AbortController): AuthInteraction {
	return {
		signal: AbortSignal.any([controller.signal, AbortSignal.timeout(5 * 60_000)]),
		notify: (event) => {
			if (event.type === "auth_url") ctx.ui.notify(`Abra no perfil Chrome desejado:\n${event.url}`, "info");
			else if (event.type === "device_code")
				ctx.ui.notify(`${event.verificationUri}\nCódigo: ${event.userCode}`, "info");
		},
		prompt: async (prompt) => {
			const signal = AbortSignal.any([
				controller.signal,
				AbortSignal.timeout(5 * 60_000),
				...(prompt.signal ? [prompt.signal] : []),
			]);
			let value: string | undefined;
			if (prompt.type === "select") {
				const labels = prompt.options.map((o) => o.label);
				const selected = await ctx.ui.select(prompt.message, labels, { signal });
				value = prompt.options.find((o) => o.label === selected)?.id;
			} else {
				value = await ctx.ui.input(prompt.message, prompt.placeholder, { signal });
			}
			if (value === undefined) {
				if (!prompt.signal?.aborted) controller.abort();
				throw new Error("Login cancelado.");
			}
			return value;
		},
	};
}

export default function codexAccounts(
	pi: ExtensionAPI,
	service: AccountService = new AccountService(
		new AccountStore(join(homedir(), ".pi", "agent", "pi-core", "codex-accounts")),
	),
	getPiAccount: () => PiAccount | undefined = readPiAccount,
): void {
	let selectedId: string | undefined;
	let busy = false;
	const usage = new Map<string, Usage | string>();
	const refreshAccountProvider = async (ctx: ExtensionContext) => {
		// Native registration starts an async auth-snapshot refresh. setModel reads
		// that snapshot synchronously, so registration alone is not a readiness barrier.
		const result = await ctx.modelRegistry.refresh({
			providers: [PERSONAL_PROVIDER],
			allowNetwork: false,
			signal: AbortSignal.timeout(15_000),
		});
		if (result.aborted || result.errors.has(PERSONAL_PROVIDER)) {
			throw new Error("Não foi possível preparar o provider da conta.");
		}
	};
	const listAccounts = async () => {
		const current = getPiAccount();
		const saved = (await service.store.list()).map((a) => ({ ...a, source: "vault" as const }));
		return current
			? [{ ...current, label: (await service.store.piLabel(current.id)) ?? current.label }, ...saved]
			: saved;
	};
	const usePiLogin = async (ctx: ExtensionContext): Promise<boolean> => {
		if (!ctx.isIdle()) return false;
		if (!ctx.model || ![PROVIDER, PERSONAL_PROVIDER].includes(ctx.model.provider)) {
			ctx.ui.notify("Selecione primeiro um modelo OpenAI Codex em /model.", "warning");
			return false;
		}
		if (ctx.model.provider === PERSONAL_PROVIDER) {
			const model = ctx.modelRegistry.find(PROVIDER, ctx.model.id);
			if (!model || !(await pi.setModel(model))) {
				ctx.ui.notify("Login padrão indisponível.", "warning");
				return false;
			}
		}
		selectedId = undefined;
		pi.appendEntry("codex-account-selection", { accountId: null });
		pi.unregisterProvider(PERSONAL_PROVIDER);
		return true;
	};

	const refresh = async (ctx: ExtensionContext) => {
		const accounts = await listAccounts();
		if (!accounts.length) return;
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const loader = new BorderedLoader(tui, theme, "Consultando limites Codex · Esc cancelar");
			const controller = new AbortController();
			loader.onAbort = () => controller.abort();
			const run = async () => {
				for (const account of accounts) {
					if (controller.signal.aborted) break;
					const key = `${account.source}:${account.id}`;
					const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]);
					try {
						usage.set(
							key,
							account.source === "pi"
								? await fetchPiAccountUsage(account.id, ctx.modelRegistry, signal)
								: await service.usage(account.id, signal),
						);
					} catch {
						usage.set(key, "indisponível (rede, login ou API); tente atualizar/reautenticar");
					}
				}
			};
			void run().finally(() => {
				loader.dispose();
				done();
			});
			return loader;
		});
	};

	const open = async (ctx: ExtensionContext) => {
		if (!ctx.hasUI) return;
		if (busy || !ctx.isIdle()) {
			ctx.ui.notify("Aguarde o agente e outras operações terminarem.", "warning");
			return;
		}
		busy = true;
		try {
			await refresh(ctx);
			while (true) {
				const accounts = await listAccounts();
				const rows = accounts.map((a, i) => {
					const u = usage.get(`${a.source}:${a.id}`);
					const active =
						a.source === "pi"
							? ctx.model?.provider === PROVIDER
							: ctx.model?.provider === PERSONAL_PROVIDER && selectedId === a.id;
					return `${i + 1}. ${active ? "●" : "○"} ${a.label}${active ? " (ativa)" : ""} · ${typeof u === "object" ? usageSummary(u) : (u ?? "não consultado")}`;
				});
				const add = "+ Adicionar conta";
				const update = "↻ Atualizar limites";
				const normal = "Usar login padrão do Pi";
				const choice = await ctx.ui.select("Contas Codex · ↑↓ navegar · Enter abrir · Esc sair", [
					...rows,
					add,
					update,
					normal,
				]);
				if (!choice) return;
				if (choice === update) {
					await refresh(ctx);
					continue;
				}
				if (choice === add) {
					const label = await ctx.ui.input("Nome da conta (até 60 caracteres)", "Pessoal / Trabalho / Outra");
					if (!label?.trim()) continue;
					try {
						normalizeLabel(label);
					} catch {
						ctx.ui.notify("Nome inválido: use de 1 a 60 caracteres, sem controles.", "warning");
						continue;
					}
					const controller = new AbortController();
					try {
						await service.login(label, interaction(ctx, controller));
						ctx.ui.notify("Conta salva. Selecione-a no menu para ativar.", "info");
					} catch {
						ctx.ui.notify(
							"Login não concluído: cancelamento, conta já cadastrada ou falha de autenticação/gravação. Nenhum token será exibido.",
							"warning",
						);
					} finally {
						controller.abort();
					}
					await refresh(ctx);
					continue;
				}
				if (choice === normal) {
					if (await usePiLogin(ctx)) return;
					continue;
				}
				const account = accounts[rows.indexOf(choice)];
				if (!account) continue;
				const u = usage.get(`${account.source}:${account.id}`);
				const details =
					typeof u === "object"
						? `${u.windows
								.map(
									(w) =>
										`${w.seconds === 604800 ? "Semana" : `${w.seconds / 3600}h`}: ${w.used}% usado; reset ${new Date(w.resetAt).toLocaleString()}`,
								)
								.join(
									"\n",
								)}\nResets disponíveis: ${u.availableResets ?? "não informado"}\nConsulta: ${new Date(u.checkedAt).toLocaleTimeString()}`
						: (u ?? "Limites não consultados");
				const action = await ctx.ui.select(
					`${account.label}\n${details}${account.source === "pi" ? "\nVinculada ao login do Pi; tokens não copiados. Remoção via /logout." : ""}`,
					account.source === "pi"
						? ["Usar nesta sessão", "Renomear conta"]
						: ["Usar nesta sessão", "Renomear conta", "Remover conta"],
				);
				if (action === "Renomear conta") {
					const label = await ctx.ui.input("Novo nome da conta (até 60 caracteres)", account.label);
					if (label === undefined) continue;
					let normalized: string;
					try {
						normalized = normalizeLabel(label);
					} catch {
						ctx.ui.notify("Nome inválido: use de 1 a 60 caracteres, sem controles.", "warning");
						continue;
					}
					if (account.source === "pi" && getPiAccount()?.id !== account.id) {
						ctx.ui.notify("O login padrão mudou. Confira a conta no menu atualizado.", "warning");
						continue;
					}
					await service.store.rename(account.id, normalized, account.source);
					ctx.ui.notify(`Conta renomeada: ${normalized}.`, "info");
					continue;
				}
				if (account.source === "pi") {
					if (action === "Usar nesta sessão") {
						if (getPiAccount()?.id !== account.id) {
							ctx.ui.notify("O login padrão mudou. Confira a conta no menu atualizado.", "warning");
						} else if (await usePiLogin(ctx)) return;
					}
					continue;
				}
				if (action === "Remover conta") {
					if (account.id === selectedId) {
						ctx.ui.notify("Troque para outra conta ou para o login padrão antes de remover.", "warning");
						continue;
					}
					if (
						await ctx.ui.confirm(
							"Remover conta?",
							"Apaga os tokens locais. Não cancela a assinatura nem revoga o login na OpenAI.",
						)
					) {
						await service.store.remove(account.id);
						usage.delete(`vault:${account.id}`);
					}
				} else if (action === "Usar nesta sessão") {
					if (!ctx.isIdle()) return;
					if (!ctx.model || ![PROVIDER, PERSONAL_PROVIDER].includes(ctx.model.provider)) {
						ctx.ui.notify("Selecione primeiro um modelo OpenAI Codex em /model.", "warning");
						continue;
					}
					const previous = selectedId;
					const provider = service.provider(account.id);
					const model = provider.getModels().find((m) => m.id === ctx.model?.id);
					if (!model) {
						ctx.ui.notify("Modelo atual não suportado.", "warning");
						continue;
					}
					try {
						pi.registerProvider(provider);
						await refreshAccountProvider(ctx);
						if (!(await pi.setModel(model))) throw new Error("Unavailable");
						selectedId = account.id;
						pi.appendEntry("codex-account-selection", { accountId: account.id, modelId: model.id });
					} catch {
						if (previous) pi.registerProvider(service.provider(previous));
						else pi.unregisterProvider(PERSONAL_PROVIDER);
						ctx.ui.notify(
							"Não foi possível atualizar a disponibilidade ou selecionar a conta. Seus logins foram preservados.",
							"warning",
						);
						continue;
					}
					ctx.ui.notify(
						`Conta ativa nesta sessão: ${account.label}. Outras sessões não foram alteradas.`,
						"info",
					);
					return;
				}
			}
		} catch {
			ctx.ui.notify(
				"Não foi possível acessar o cofre de contas. Confira permissões e integridade; não apague o arquivo para tentar corrigir.",
				"error",
			);
		} finally {
			busy = false;
		}
	};

	// Custom entries are extension state, excluded from model context by Pi.
	pi.on("session_start", async (_event, ctx) => {
		if (selectedId) pi.unregisterProvider(PERSONAL_PROVIDER);
		selectedId = undefined;
		const entry = ctx.sessionManager
			.getBranch()
			.slice()
			.reverse()
			.find((e) => e.type === "custom" && e.customType === "codex-account-selection");
		const data = (entry?.type === "custom" ? entry.data : undefined) as
			| { accountId?: unknown; modelId?: unknown }
			| undefined;
		if (typeof data?.accountId !== "string" || typeof data.modelId !== "string") {
			if (ctx.model?.provider === PERSONAL_PROVIDER) {
				const normal = ctx.modelRegistry.find(PROVIDER, ctx.model.id);
				if (normal) await pi.setModel(normal);
			}
			return;
		}
		selectedId = data.accountId;
		// Keep removed accounts fail-closed: do not silently spend a different account's quota.
		const provider = service.provider(selectedId);
		try {
			pi.registerProvider(provider);
			await refreshAccountProvider(ctx);
			const model = provider.getModels().find((m) => m.id === data.modelId);
			if (model && ctx.model && [PROVIDER, PERSONAL_PROVIDER].includes(ctx.model.provider)) {
				if (!(await pi.setModel(model))) throw new Error("Unavailable");
			}
		} catch {
			ctx.ui.notify(
				"Conta salva indisponível. Selecione uma conta em /codex-accounts antes de continuar.",
				"warning",
			);
		}
	});

	pi.registerCommand("codex-accounts", {
		description: "Gerenciar contas pessoais Codex e consultar limites",
		handler: (_args, ctx) => open(ctx),
	});
	pi.registerShortcut("ctrl+alt+a", { description: "Contas Codex", handler: open });
}
