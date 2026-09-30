import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import {
	AccountPanel,
	type AccountPanelState,
	type AccountTab,
	showAccountPanel,
} from "../extensions/codex-accounts/panel.js";

const theme: Pick<Theme, "fg" | "bg" | "bold"> = {
	fg: (_color, text) => `\u001b[36m${text}\u001b[39m`,
	bg: (_color, text) => `\u001b[40m${text}\u001b[49m`,
	bold: (text) => `\u001b[1m${text}\u001b[22m`,
};
const accounts: [AccountTab, AccountTab, AccountTab] = [
	{ key: "pi:same-id", label: "Pessoal", source: "pi", active: false, isDefault: false },
	{
		key: "vault:same-id",
		label: "Trabalho",
		source: "vault",
		active: true,
		isDefault: true,
		usage: {
			checkedAt: 1000,
			availableResets: 2,
			windows: [
				{ seconds: 18000, used: 20, resetAt: 2000000 },
				{ seconds: 604800, used: 90, resetAt: 3000000 },
			],
		},
	},
	{ key: "vault:other", label: "Outra", source: "vault", active: false, isDefault: false },
];
function setup(state: AccountPanelState = { accounts, defaultId: "same-id" }) {
	const done = vi.fn();
	const render = vi.fn();
	const panel = new AccountPanel(state, theme, done, render);
	const text = (width = 80) => panel.render(width).map(stripTerminalSequences).join("\n");
	return { panel, done, render, text };
}

describe("Codex account tabs", () => {
	it("starts on the active account, with usage, reset credits and distinct default status", () => {
		const { panel, text, done } = setup();
		expect(text()).toContain("2 / 3");
		expect(text()).toContain("80% livre");
		expect(text()).toContain("10% livre");
		expect(text()).toContain("Créditos de reset  2");
		expect(text()).toContain("Padrão para novas sessões");
		expect(text()).toContain("Ativa nesta sessão");
		expect(text()).toContain("Tab / Shift+Tab");
		panel.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ action: "activate", accountKey: "vault:same-id" });
	});
	it("cycles with Tab / Shift+Tab in both directions without activating accounts", () => {
		const { panel, done, text } = setup();
		panel.handleInput("\t");
		expect(text()).toContain("3 / 3");
		panel.handleInput("\t");
		expect(text()).toContain("1 / 3");
		panel.handleInput("\u001b[Z");
		expect(text()).toContain("3 / 3");
		expect(done).not.toHaveBeenCalled();
		panel.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ action: "activate", accountKey: "vault:other" });
	});
	it("supports arrow tab navigation and Escape", () => {
		const { panel, done, text } = setup();
		panel.handleInput("\u001b[D");
		expect(text()).toContain("1 / 3");
		panel.handleInput("\u001b[C");
		expect(text()).toContain("2 / 3");
		panel.handleInput("\u001b");
		expect(done).toHaveBeenCalledWith(undefined);
	});
	it("remembers the viewed tab by source-qualified identity and falls back after removal", () => {
		const { panel, done } = setup({ accounts, focusKey: "pi:same-id" });
		panel.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ action: "activate", accountKey: "pi:same-id" });
		expect(setup({ accounts, focusKey: "removed" }).text()).toContain("2 / 3");
	});
	it("resets action focus when changing tabs so a destructive action is never preselected", () => {
		const { panel, done } = setup();
		panel.handleInput("\u001b[B");
		panel.handleInput("\t");
		panel.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ action: "activate", accountKey: "vault:other" });
	});
	it("uses the native action selector for reset, without performing a redemption", () => {
		const { panel, done } = setup();
		panel.handleInput("\u001b[B");
		panel.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ action: "reset", accountKey: "vault:same-id" });
	});
	it("keeps missing windows and failed usage explicit rather than showing full quota", () => {
		const partial = setup({
			accounts: [{ ...accounts[0], usage: { windows: [], availableResets: 0, checkedAt: 1000 } }],
		});
		expect(partial.text()).toContain("Não informado");
		expect(partial.text()).toContain("Créditos de reset  0");
		expect(partial.text()).not.toContain("Usar 1 crédito");
		const failure = setup({ accounts: [{ ...accounts[0], usage: "SECRET_BACKEND_ERROR" }] });
		expect(failure.text()).toContain("Limites indisponíveis");
		expect(failure.text()).not.toContain("SECRET_BACKEND_ERROR");
		expect(failure.text()).not.toContain("100%");
	});
	it("hides removal for the Pi login and the active account", () => {
		for (const account of [accounts[0], accounts[1]]) {
			const { panel, text } = setup({ accounts: [account] });
			for (let i = 0; i < 10; i++) {
				expect(text()).not.toContain("Remover conta");
				panel.handleInput("\u001b[B");
			}
		}
	});
	it("supports empty accounts and global actions", () => {
		const { panel, done, text } = setup({ accounts: [] });
		expect(text()).toContain("Adicione uma conta");
		panel.handleInput("\t");
		panel.handleInput("\u001b[Z");
		panel.handleInput("\r");
		expect(done).toHaveBeenCalledWith({ action: "add", accountKey: undefined });
	});
	it.each([0, 1, 8, 20, 40, 80, 120])(
		"bounds every rendered line at %s columns across resize and long Unicode tabs",
		(width) => {
			const many = Array.from({ length: 30 }, (_, i) => ({
				...accounts[2],
				key: String(i),
				label: `${i} 帳戶 👩‍💻 ${"Long name ".repeat(6)}`,
			}));
			const { panel } = setup({ accounts: many, focusKey: "29" });
			for (const size of [80, width, 40]) {
				panel.invalidate();
				const lines = panel.render(size);
				for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(size);
			}
		},
	);
	it("keeps the selected tab visible in an overflowing tab strip", () => {
		const many = Array.from({ length: 20 }, (_, i) => ({
			...accounts[2],
			key: String(i),
			label: `Account ${i}`,
		}));
		const { text, panel } = setup({ accounts: many, focusKey: "19" });
		expect(text(40).split("\n")[1]).toContain("Account 19");
		expect(text(40)).toContain("20 / 20");
		panel.handleInput("\t");
		expect(text(40).split("\n")[1]).toContain("Account 0");
	});
	it("fits the populated dashboard in a standard 24-row terminal", () => {
		expect(setup().panel.render(80).length).toBeLessThanOrEqual(24);
	});
	it("wires the real panel through Pi custom UI", async () => {
		const custom = vi.fn(async (factory) => {
			const done = vi.fn();
			const requestRender = vi.fn();
			const component = factory({ requestRender, terminal: { rows: 8 } }, theme, {}, done);
			expect(component.render(30).length).toBeLessThanOrEqual(8);
			expect(component.render(30).every((line: string) => visibleWidth(line) <= 30)).toBe(true);
			component.handleInput("\t");
			component.handleInput("\r");
			expect(requestRender).toHaveBeenCalled();
			return done.mock.calls[0]?.[0];
		});
		await expect(showAccountPanel({ ui: { custom } } as never, { accounts })).resolves.toEqual({
			action: "activate",
			accountKey: "vault:other",
		});
	});
});
