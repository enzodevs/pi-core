import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Input,
	Key,
	matchesKey,
	stripTerminalSequences,
	truncateToWidth,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import { sectionPanel, wrapped } from "../ui/sections.js";
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
	allSkills: SkillManagerItem[],
	onChange: (scope: SkillManagerScope, name: string, mode: SkillManagerValue) => void | Promise<void>,
	initialScope: SkillManagerScope = "project",
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let scope = initialScope;
		let skills = allSkills;
		let searching = false;
		let focused = false;
		let saving = false;
		let feedback = "Changes apply to future agent requests.";
		const search = new Input({ prompt: "Search: ", placeholder: "skill name or description" });
		let selected = 0;
		let top = 0;
		const globalModes = new Map(allSkills.map((skill) => [skill.name, skill.globalMode]));
		const projectModes = new Map(allSkills.map((skill) => [skill.name, skill.projectMode]));
		const visibleRows = () => Math.max(1, Math.min(12, tui.terminal.rows - 10));

		const move = (delta: number) => {
			if (skills.length === 0) return;
			selected = (((selected + delta) % skills.length) + skills.length) % skills.length;
			if (selected < top) top = selected;
			if (selected >= top + visibleRows()) top = selected - visibleRows() + 1;
		};

		const switchScope = () => {
			scope = scope === "project" ? "global" : "project";
		};

		const change = async (direction: 1 | -1) => {
			const skill = skills[selected];
			if (!skill || saving) return;
			const targetScope = scope;
			const modes = targetScope === "global" ? globalModes : projectModes;
			const value = nextValue(modes.get(skill.name) ?? "inherit", direction);
			saving = true;
			feedback = `Saving ${skill.name}…`;
			tui.requestRender();
			try {
				await onChange(targetScope, skill.name, value);
				modes.set(skill.name, value === "inherit" ? undefined : value);
				feedback = `Saved · ${skill.name}: ${value} (${targetScope})`;
			} catch {
				feedback = "Save failed · previous setting kept. Retry with ←/→.";
			} finally {
				saving = false;
				tui.requestRender();
			}
		};

		const component: Component & { focused: boolean } = {
			get focused() {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				search.focused = value && searching;
			},
			invalidate() {
				search.invalidate();
			},
			render(width) {
				const safeWidth = Math.max(1, width);
				const compact = safeWidth < 52;
				selected = Math.min(selected, Math.max(0, skills.length - 1));
				top = Math.max(0, Math.min(top, selected, Math.max(0, skills.length - visibleRows())));
				if (selected >= top + visibleRows()) top = selected - visibleRows() + 1;
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
				if (searching) lines.push(...search.render(safeWidth));
				else if (search.getValue())
					lines.push(theme.fg("muted", truncateToWidth(`Filter: ${search.getValue()} · / edit`, safeWidth)));
				else lines.push("");
				if (skills.length === 0) lines.push(theme.fg("muted", "No matching skills."));

				const header = lines.splice(0);
				const end = Math.min(skills.length, top + visibleRows());
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

				if (skills.length > visibleRows()) lines.push(theme.fg("dim", `  ${selected + 1}/${skills.length}`));
				const current = skills[selected];
				if (current) {
					const explicit = (scope === "global" ? globalModes : projectModes).get(current.name);
					const inherited =
						scope === "global" ? current.defaultMode : (globalModes.get(current.name) ?? current.defaultMode);
					const mode = explicit ?? inherited;
					const source = explicit
						? scope
						: scope === "project" && globalModes.has(current.name) && globalModes.get(current.name)
							? "global"
							: "default";
					const meaning: Record<SkillMode, string> = {
						full: "Name and description visible; instructions load on demand.",
						name: "Only name visible; instructions load on demand.",
						searchable: "Hidden from prompt; available through skill search.",
						off: "Hidden and unavailable to search/load.",
					};
					lines.push(
						theme.fg("accent", `${mode} · ${explicit ? `set in ${source}` : `inherited from ${source}`}`),
					);
					lines.push(
						...wrapped(meaning[mode], safeWidth)
							.slice(0, 2)
							.map((line) => theme.fg("muted", line)),
					);
					for (const line of wrapTextWithAnsi(current.description, Math.max(8, safeWidth - 2)).slice(
						0,
						compact ? 2 : 3,
					)) {
						lines.push(theme.fg("muted", `  ${line}`));
					}
				}
				const fullHint = searching
					? "Type to filter · Enter navigate · Esc clear"
					: "/ search  Tab/⇧Tab scope  ↑↓ navigate  ←→ change  Home/End jump  Esc close";
				const compactHint = searching
					? "Enter navigate · Esc clear"
					: "/ search  Tab scope  ↑↓ move  ←→ change  Esc close";
				return sectionPanel(
					header,
					lines,
					[
						theme.fg(
							feedback.startsWith("Save failed")
								? "error"
								: saving
									? "warning"
									: feedback.startsWith("Saved")
										? "success"
										: "dim",
							feedback,
						),
						theme.fg("dim", compact ? compactHint : fullHint),
					],
					safeWidth,
					tui.terminal.rows,
				);
			},
			handleInput(data) {
				if (searching) {
					if (matchesKey(data, Key.enter) || matchesKey(data, Key.escape)) {
						if (matchesKey(data, Key.escape)) search.setValue("");
						searching = false;
						search.focused = false;
					} else search.handleInput(data);
					const query = search.getValue().toLowerCase();
					skills = allSkills.filter((skill) =>
						`${skill.name} ${skill.description}`.toLowerCase().includes(query),
					);
					selected = 0;
					top = 0;
					tui.requestRender();
					return;
				}
				if (data === "/") {
					searching = true;
					search.focused = focused;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, Key.escape)) {
					if (!saving) return done();
					return;
				}
				if (matchesKey(data, Key.tab) || matchesKey(data, Key.shift(Key.tab))) switchScope();
				else if (matchesKey(data, Key.up)) move(-1);
				else if (matchesKey(data, Key.down)) move(1);
				else if (matchesKey(data, Key.pageUp)) move(-visibleRows());
				else if (matchesKey(data, Key.pageDown)) move(visibleRows());
				else if (matchesKey(data, Key.home)) {
					selected = 0;
					top = 0;
				} else if (matchesKey(data, Key.end)) {
					selected = Math.max(0, skills.length - 1);
					top = Math.max(0, skills.length - visibleRows());
				} else if (matchesKey(data, Key.left)) void change(-1);
				else if (matchesKey(data, Key.right) || matchesKey(data, Key.enter) || matchesKey(data, Key.space))
					void change(1);
				tui.requestRender();
			},
		};
		return component;
	});
}
