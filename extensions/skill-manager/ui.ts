import { type ExtensionCommandContext, getSettingsListTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import type { SkillMode } from "./types.js";

interface ManagerItem {
	name: string;
	description: string;
	mode: SkillMode;
}

export async function showSkillManager(
	ctx: ExtensionCommandContext,
	items: readonly ManagerItem[],
	onChange: (name: string, mode: SkillMode) => void,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		const container = new Container();
		container.addChild(
			new Text(theme.fg("accent", theme.bold("Skill visibility · current directory")), 1, 0),
		);
		container.addChild(
			new Text(theme.fg("dim", "full: automatic · name: listed · searchable: on demand · off: hidden"), 1, 0),
		);
		const settingsItems: SettingItem[] = items.map((item) => ({
			id: item.name,
			label: item.name,
			description: item.description,
			currentValue: item.mode,
			values: ["full", "name", "searchable", "off"],
		}));
		const list = new SettingsList(
			settingsItems,
			Math.min(items.length + 2, 18),
			getSettingsListTheme(),
			(id, value) => onChange(id, value as SkillMode),
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(list);
		container.addChild(new Text(theme.fg("dim", "type to search · ←→ change · esc close"), 1, 0));
		return {
			render: (width) => container.render(width),
			invalidate: () => container.invalidate(),
			handleInput: (data) => {
				list.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}
