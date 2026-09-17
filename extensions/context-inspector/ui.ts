import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export async function showContextInspector(
	ctx: ExtensionCommandContext,
	title: string,
	content: string,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let top = 0;
		const summary = title === "summary" ? content.split("\n") : undefined;
		const component: Component = {
			invalidate() {},
			render(width) {
				const safeWidth = Math.max(12, width);
				const bodyWidth = Math.max(8, safeWidth - 2);
				const sourceLines = summary ? renderSummary(summary, bodyWidth, theme) : content.split("\n");
				const lines = sourceLines.flatMap((line) => wrapTextWithAnsi(line || " ", bodyWidth));
				const visibleRows = Math.max(3, tui.terminal.rows - 5);
				const maxTop = Math.max(0, lines.length - visibleRows);
				top = Math.min(top, maxTop);
				return [
					theme.fg(
						"accent",
						theme.bold(
							truncateToWidth(title === "summary" ? "Context budget" : `Context · ${title}`, safeWidth),
						),
					),
					...lines.slice(top, top + visibleRows).map((line) => ` ${truncateToWidth(line, bodyWidth)}`),
					theme.fg(
						"dim",
						truncateToWidth(
							`${top + 1}-${Math.min(lines.length, top + visibleRows)}/${lines.length}  ↑↓ scroll  PgUp/PgDn jump  Esc close`,
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

function renderSummary(
	lines: string[],
	width: number,
	theme: {
		fg(color: "accent" | "dim" | "muted" | "success" | "warning" | "error", text: string): string;
		bold(text: string): string;
	},
): string[] {
	const next = lines.find((line) => line.startsWith("next request estimate:")) ?? "";
	const match = next.match(/~([\d.,]+) \/ ([\d.,]+|unknown) tokens \(~([\d.]+|unknown)%\)/);
	const percent = match?.[3] === "unknown" ? 0 : Number(match?.[3] ?? 0);
	const barWidth = Math.max(12, Math.min(48, width - 2));
	const filled = Math.min(barWidth, Math.round((percent / 100) * barWidth));
	const color = percent >= 85 ? "error" : percent >= 65 ? "warning" : "success";
	const bar = `${theme.fg(color, "█".repeat(filled))}${theme.fg("dim", "░".repeat(barWidth - filled))}`;
	const value = match
		? `~${match[1]} of ${match[2]} tokens  ·  ~${match[3]}%`
		: next.replace(/^next request estimate: /, "");
	const breakdown = lines.find((line) => line.startsWith("breakdown:"))?.replace("breakdown: ", "") ?? "";
	const files = lines.find((line) => line.startsWith("context files:")) ?? "";
	const skills = lines.find((line) => line.startsWith("skills loaded:")) ?? "";
	const tools = lines.find((line) => line.startsWith("tools selected:")) ?? "";
	const measured =
		lines.find((line) => line.startsWith("last measured:"))?.replace("last measured: ", "") ?? "";
	return [
		"",
		theme.bold("Next model request"),
		bar,
		theme.fg(color, theme.bold(value)),
		theme.fg("muted", breakdown),
		"",
		theme.bold("What is loaded"),
		`${files}  ·  ${skills}  ·  ${tools}`,
		"",
		theme.bold("Provider reading"),
		measured === "not available yet"
			? theme.fg("dim", "Not measured yet — appears after the first model response")
			: `${measured} in the last provider response`,
		"",
		theme.fg("accent", "/context files") + theme.fg("dim", "  inspect instructions and paths"),
		theme.fg("accent", "/context skills") + theme.fg("dim", " inspect loaded skills"),
		theme.fg("accent", "/context tools") + theme.fg("dim", "  inspect active tools"),
		theme.fg("accent", "/context messages") + theme.fg("dim", "  inspect the last model context"),
		theme.fg("accent", "/context payload") + theme.fg("dim", "   inspect the last provider body"),
		"",
		theme.fg("dim", "~ estimates use the same conservative 4-characters/token rule as Pi."),
	];
}
