import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	type SelectItem,
	SelectList,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { Usage } from "./usage.js";

export interface AccountTab {
	key: string;
	label: string;
	source: "pi" | "vault";
	active: boolean;
	isDefault: boolean;
	usage?: Usage | string;
}
export interface AccountPanelState {
	accounts: AccountTab[];
	defaultId?: string;
	focusKey?: string;
}
export type AccountAction =
	| "activate"
	| "reset"
	| "rename"
	| "remove"
	| "default"
	| "clear-default"
	| "add"
	| "refresh"
	| "pi-login";
export interface AccountChoice {
	action: AccountAction;
	accountKey?: string;
}

/** Presentation only: browsing tabs never changes credentials or makes requests. */
export class AccountPanel implements Component {
	private tabIndex: number;
	private actions: SelectList;

	constructor(
		private readonly state: AccountPanelState,
		private readonly theme: Pick<Theme, "fg" | "bg" | "bold">,
		private readonly done: (choice: AccountChoice | undefined) => void,
		private readonly requestRender: () => void,
	) {
		const remembered = state.accounts.findIndex((account) => account.key === state.focusKey);
		const active = state.accounts.findIndex((account) => account.active);
		this.tabIndex = Math.max(0, remembered >= 0 ? remembered : active);
		this.actions = this.createActions();
	}

	private createActions(): SelectList {
		const account = this.state.accounts[this.tabIndex];
		const items: SelectItem[] = [];
		if (account) {
			items.push({
				value: "activate",
				label: account.active ? "Continuar nesta conta" : "Ativar nesta sessão",
				description: "Não altera outras sessões",
			});
			if (typeof account.usage === "object" && (account.usage.availableResets ?? 0) > 0)
				items.push({
					value: "reset",
					label: "Usar 1 crédito de reset",
					description: "Pede confirmação antes de consumir",
				});
			if (account.source === "vault" && !account.isDefault)
				items.push({
					value: "default",
					label: "Definir como padrão",
					description: "Somente para novas sessões",
				});
			items.push({ value: "rename", label: "Renomear conta", description: "Nome local, sem mudar o login" });
			if (account.source === "vault" && !account.active)
				items.push({
					value: "remove",
					label: "Remover conta…",
					description: "Apaga o login salvo; pede confirmação",
				});
		}
		items.push(
			{ value: "refresh", label: "Atualizar limites", description: "Consultar todas as contas" },
			{ value: "add", label: "Adicionar conta…", description: "Entrar com outro perfil" },
			{ value: "pi-login", label: "Usar login do Pi", description: "Voltar à autenticação normal" },
		);
		if (this.state.defaultId)
			items.push({
				value: "clear-default",
				label: "Limpar conta padrão",
				description: "Novas sessões voltam ao login do Pi",
			});
		const list = new SelectList(items, 5, {
			selectedPrefix: (text) => this.theme.fg("accent", text),
			selectedText: (text) => this.theme.fg("accent", this.theme.bold(text)),
			description: (text) => this.theme.fg("muted", text),
			scrollInfo: (text) => this.theme.fg("dim", text),
			noMatch: (text) => this.theme.fg("muted", text),
		});
		if (!account) list.setSelectedIndex(1);
		list.onSelect = (item) => this.done({ action: item.value as AccountAction, accountKey: account?.key });
		list.onCancel = () => this.done(undefined);
		return list;
	}

	handleInput(data: string): void {
		const next = matchesKey(data, Key.tab) || matchesKey(data, Key.right);
		const previous = matchesKey(data, Key.shift("tab")) || matchesKey(data, Key.left);
		if (next || previous) {
			const count = this.state.accounts.length;
			if (count > 0) {
				this.tabIndex = (this.tabIndex + (next ? 1 : -1) + count) % count;
				this.actions = this.createActions();
			}
		} else {
			this.actions.handleInput(data);
		}
		this.requestRender();
	}

	invalidate(): void {
		this.actions.invalidate();
	}

	private tabs(width: number): string {
		const accounts = this.state.accounts;
		if (!accounts.length) return this.theme.fg("muted", "Nenhuma conta conectada");
		const tabWidth = Math.max(1, Math.min(24, width - 4));
		const labels = accounts.map(
			(account) =>
				` ${truncateToWidth(`${account.active ? "● " : ""}${account.label}`, Math.max(1, tabWidth - 2))} `,
		);
		let start = this.tabIndex;
		let end = start + 1;
		let used = visibleWidth(labels[start] ?? "") + 4;
		// A sliding strip keeps the focused tab visible even with many long labels.
		while (end < labels.length && used + visibleWidth(labels[end] ?? "") + 1 <= width) {
			used += visibleWidth(labels[end] ?? "") + 1;
			end++;
		}
		while (start > 0 && used + visibleWidth(labels[start - 1] ?? "") + 1 <= width) {
			start--;
			used += visibleWidth(labels[start] ?? "") + 1;
		}
		const strip = labels
			.slice(start, end)
			.map((label, offset) =>
				start + offset === this.tabIndex
					? this.theme.bg("selectedBg", this.theme.fg("accent", this.theme.bold(label)))
					: this.theme.fg("muted", label),
			)
			.join(" ");
		return `${start > 0 ? "‹ " : "  "}${strip}${end < labels.length ? " ›" : ""}`;
	}

	private usageLines(account: AccountTab, width: number): string[] {
		const usage = account.usage;
		if (typeof usage !== "object")
			return [
				this.theme.fg("warning", usage ? "Limites indisponíveis" : "Limites ainda não consultados"),
				this.theme.fg("muted", "Use Atualizar limites para tentar novamente."),
			];
		const lines: string[] = [];
		for (const [seconds, label] of [
			[18000, "5 horas"],
			[604800, "Semana"],
		] as const) {
			const window = usage.windows.find((item) => item.seconds === seconds);
			if (!window) {
				lines.push(`${label.padEnd(8)} ${this.theme.fg("muted", "Não informado")}`);
				continue;
			}
			const remaining = Math.max(0, Math.min(100, 100 - window.used));
			const size = Math.max(4, Math.min(24, width - 26));
			const filled = Math.round((remaining * size) / 100);
			const color = remaining <= 10 ? "error" : remaining <= 25 ? "warning" : "success";
			lines.push(
				`${label.padEnd(8)} ${this.theme.fg(color, "━".repeat(filled))}${this.theme.fg("dim", "─".repeat(size - filled))} ${this.theme.fg(color, `${Math.round(remaining)}% livre`)}`,
			);
			lines.push(
				this.theme.fg(
					"dim",
					`         Renova ${new Date(window.resetAt).toLocaleString("pt-BR", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`,
				),
			);
		}
		lines.push(`Créditos de reset  ${this.theme.bold(String(usage.availableResets ?? "Não informado"))}`);
		lines.push(
			this.theme.fg(
				"dim",
				`Consulta ${new Date(usage.checkedAt).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" })} · atualização manual`,
			),
		);
		return lines;
	}

	render(width: number): string[] {
		const inner = Math.max(1, width - 4);
		const account = this.state.accounts[this.tabIndex];
		const lines = [
			this.theme.fg("accent", this.theme.bold("CONTAS CODEX")) +
				this.theme.fg(
					"dim",
					`  ${this.state.accounts.length ? `${this.tabIndex + 1} / ${this.state.accounts.length}` : "Primeiro acesso"}`,
				),
			this.tabs(inner),
			this.theme.fg("borderMuted", "─".repeat(inner)),
		];
		if (account) {
			lines.push(this.theme.bold(account.label));
			lines.push(
				[
					account.active
						? this.theme.fg("success", "● Ativa nesta sessão")
						: this.theme.fg("muted", "○ Não ativa nesta sessão"),
					...(account.isDefault
						? [this.theme.fg("accent", inner < 60 ? "★ Padrão" : "★ Padrão para novas sessões")]
						: []),
				].join("  ·  "),
			);
			lines.push(
				this.theme.fg(
					"dim",
					account.source === "pi" ? "Login do Pi · /login e /logout" : "Conta salva no cofre local",
				),
				...this.usageLines(account, inner),
			);
		} else {
			lines.push(
				"Adicione uma conta para começar.",
				this.theme.fg("muted", "Se você já entrou pelo Pi, confira /login."),
			);
		}
		lines.push(
			this.theme.fg("borderMuted", "─".repeat(inner)),
			this.theme.fg("muted", "AÇÕES"),
			...this.actions.render(inner),
			this.theme.fg("dim", "Tab / Shift+Tab · trocar aba"),
			this.theme.fg("dim", "↑↓ ações · Enter escolher · Esc sair"),
		);
		const border = this.theme.fg("borderMuted", "─".repeat(Math.max(0, width)));
		return [border, ...lines.map((line) => truncateToWidth(`  ${line}`, Math.max(0, width), "…")), border];
	}
}

export function showAccountPanel(
	ctx: ExtensionContext,
	state: AccountPanelState,
): Promise<AccountChoice | undefined> {
	return ctx.ui.custom<AccountChoice | undefined>(
		(tui, theme, _keys, done) => new AccountPanel(state, theme, done, () => tui.requestRender()),
	);
}
