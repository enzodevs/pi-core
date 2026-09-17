import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export async function showContextInspector(
	ctx: ExtensionCommandContext,
	title: string,
	content: string,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let top = 0;
		const component: Component = {
			invalidate() {},
			render(width) {
				const safeWidth = Math.max(12, width);
				const bodyWidth = Math.max(8, safeWidth - 2);
				const lines = content.split("\n").flatMap((line) => wrapTextWithAnsi(line || " ", bodyWidth));
				const visibleRows = Math.max(3, tui.terminal.rows - 5);
				const maxTop = Math.max(0, lines.length - visibleRows);
				top = Math.min(top, maxTop);
				return [
					theme.bold(truncateToWidth(`Context · ${title}`, safeWidth)),
					...lines.slice(top, top + visibleRows).map((line) => ` ${truncateToWidth(line, bodyWidth)}`),
					theme.fg(
						"dim",
						truncateToWidth(
							`${top + 1}-${Math.min(lines.length, top + visibleRows)}/${lines.length} · ↑↓ PgUp/PgDn Home/End · Esc close`,
							safeWidth,
						),
					),
				];
			},
			handleInput(data) {
				const page = Math.max(3, tui.terminal.rows - 5);
				if (matchesKey(data, Key.escape) || matchesKey(data, Key.enter)) return done();
				if (matchesKey(data, Key.up)) top = Math.max(0, top - 1);
				else if (matchesKey(data, Key.down)) top += 1;
				else if (matchesKey(data, Key.pageUp)) top = Math.max(0, top - page);
				else if (matchesKey(data, Key.pageDown)) top += page;
				else if (matchesKey(data, Key.home)) top = 0;
				else if (matchesKey(data, Key.end)) top = Number.MAX_SAFE_INTEGER;
				tui.requestRender();
			},
		};
		return component;
	});
}
