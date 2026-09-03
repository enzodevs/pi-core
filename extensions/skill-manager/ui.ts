import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Key,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { SKILL_MODES, type SkillMode } from "./types.js";

export type SkillManagerValue = SkillMode | "inherit";
export type SkillManagerScope = "project" | "global";

export interface SkillManagerItem {
	name: string;
	description: string;
	defaultMode: SkillMode;
	globalMode?: SkillMode;
	projectMode?: SkillMode;
}

const VALUES: readonly SkillManagerValue[] = ["inherit", ...SKILL_MODES];

function nextValue(current: SkillManagerValue, direction: 1 | -1): SkillManagerValue {
	const index = VALUES.indexOf(current);
	return VALUES[(index + direction + VALUES.length) % VALUES.length] ?? "inherit";
}

export async function showSkillManager(
	ctx: ExtensionCommandContext,
	skills: SkillManagerItem[],
	onChange: (scope: SkillManagerScope, name: string, mode: SkillManagerValue) => void,
	initialScope: SkillManagerScope = "project",
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let scope = initialScope;
		let selected = 0;
		let top = 0;
		const globalModes = new Map(skills.map((skill) => [skill.name, skill.globalMode]));
		const projectModes = new Map(skills.map((skill) => [skill.name, skill.projectMode]));
		const visibleRows = Math.max(3, Math.min(12, tui.terminal.rows - 10));

		const move = (delta: number) => {
			if (skills.length === 0) return;
			selected = (selected + delta + skills.length) % skills.length;
			if (selected < top) top = selected;
			if (selected >= top + visibleRows) top = selected - visibleRows + 1;
		};

		const switchScope = () => {
			scope = scope === "project" ? "global" : "project";
		};

		const change = (direction: 1 | -1) => {
			const skill = skills[selected];
			if (!skill) return;
			const modes = scope === "global" ? globalModes : projectModes;
			const value = nextValue(modes.get(skill.name) ?? "inherit", direction);
			modes.set(skill.name, value === "inherit" ? undefined : value);
			onChange(scope, skill.name, value);
		};

		const component: Component = {
			invalidate() {},
			render(width) {
				const safeWidth = Math.max(12, width);
				const compact = safeWidth < 52;
				const lines: string[] = [];
				const scopeTab = (name: SkillManagerScope) =>
					name === scope ? theme.fg("accent", theme.bold(`[${name}]`)) : theme.fg("dim", ` ${name} `);
				lines.push(
					truncateToWidth(
						`${theme.bold("Skill manager")}  ${scopeTab("project")} ${scopeTab("global")}`,
						safeWidth,
					),
				);
				lines.push(
					theme.fg("dim", truncateToWidth(`${skills.length} skills · Tab switches scope`, safeWidth)),
				);
				lines.push("");

				const end = Math.min(skills.length, top + visibleRows);
				for (let index = top; index < end; index++) {
					const skill = skills[index];
					if (!skill) continue;
					const active = index === selected;
					const explicit = (scope === "global" ? globalModes : projectModes).get(skill.name);
					const inherited =
						scope === "global" ? skill.defaultMode : (globalModes.get(skill.name) ?? skill.defaultMode);
					const inheritedSource =
						scope === "global" ? "default" : globalModes.get(skill.name) ? "global" : "default";
					const mode = explicit ?? inherited;
					const source = explicit ? scope : inheritedSource;
					const value = explicit ? mode : `↳ ${mode}`;
					const prefix = active ? theme.fg("accent", "› ") : "  ";
					const valueStyled = active ? theme.fg("accent", theme.bold(value)) : theme.fg("muted", value);
					const sourceStyled = theme.fg("dim", source);
					const right = compact ? valueStyled : `${valueStyled}  ${sourceStyled}`;
					const rightWidth = visibleWidth(stripTerminalSequences(right));
					const nameWidth = Math.max(4, safeWidth - 2 - rightWidth - 2);
					const name = truncateToWidth(skill.name, nameWidth, "…");
					const gap = " ".repeat(Math.max(1, safeWidth - 2 - visibleWidth(name) - rightWidth));
					lines.push(
						truncateToWidth(`${prefix}${active ? theme.bold(name) : name}${gap}${right}`, safeWidth),
					);
				}

				if (skills.length > visibleRows) lines.push(theme.fg("dim", `  ${selected + 1}/${skills.length}`));
				const current = skills[selected];
				if (current) {
					lines.push("");
					for (const line of wrapTextWithAnsi(current.description, Math.max(8, safeWidth - 2)).slice(
						0,
						compact ? 2 : 3,
					)) {
						lines.push(theme.fg("muted", `  ${line}`));
					}
				}
				lines.push("");
				const fullHint = "Tab/⇧Tab scope  ↑↓ navigate  ←→ change  Home/End jump  Esc close";
				const compactHint = "Tab scope  ↑↓ move  ←→ change  Esc close";
				lines.push(theme.fg("dim", truncateToWidth(compact ? compactHint : fullHint, safeWidth)));
				return lines;
			},
			handleInput(data) {
				if (matchesKey(data, Key.escape)) return done();
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift(Key.tab))) switchScope();
				else if (matchesKey(data, Key.up)) move(-1);
				else if (matchesKey(data, Key.down)) move(1);
				else if (matchesKey(data, Key.pageUp)) move(-visibleRows);
				else if (matchesKey(data, Key.pageDown)) move(visibleRows);
				else if (matchesKey(data, Key.home)) {
					selected = 0;
					top = 0;
				} else if (matchesKey(data, Key.end)) {
					selected = Math.max(0, skills.length - 1);
					top = Math.max(0, skills.length - visibleRows);
				} else if (matchesKey(data, Key.left)) change(-1);
				else if (matchesKey(data, Key.right) || matchesKey(data, Key.enter) || matchesKey(data, Key.space))
					change(1);
				tui.requestRender();
			},
		};
		return component;
	});
}
