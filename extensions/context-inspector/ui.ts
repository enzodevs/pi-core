import type { BuildSystemPromptOptions, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { type ContextView, contextFileSource, estimateTextTokens } from "./core.js";

interface InspectorData {
	options: BuildSystemPromptOptions;
	messages: readonly unknown[];
}
interface InspectorItem {
	title: string;
	meta: string;
	detail: string;
}
type ThemeLike = {
	fg(color: "accent" | "dim" | "muted" | "success" | "warning" | "error", text: string): string;
	bold(text: string): string;
};

export async function showContextInspector(
	ctx: ExtensionCommandContext,
	view: ContextView,
	content: string,
	data: InspectorData,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let top = 0;
		let selected = 0;
		const summary = view === "summary" ? content.split("\n") : undefined;
		const items = listItems(view, data);
		const component: Component = {
			invalidate() {},
			render(width) {
				const safeWidth = Math.max(12, width);
				if (items) {
					const visibleItems = Math.max(2, Math.floor((tui.terminal.rows - 11) / 2));
					if (selected < top) top = selected;
					if (selected >= top + visibleItems) top = selected - visibleItems + 1;
					return renderInventory(view, items, selected, top, visibleItems, safeWidth, theme);
				}
				const bodyWidth = Math.max(8, safeWidth - 2);
				const source = summary ? renderSummary(summary, bodyWidth, theme) : styledRaw(view, content, theme);
				const lines = source.flatMap((line) => wrapTextWithAnsi(line || " ", bodyWidth));
				const visibleRows = Math.max(3, tui.terminal.rows - 5);
				top = Math.min(top, Math.max(0, lines.length - visibleRows));
				return [
					theme.fg("accent", theme.bold(view === "summary" ? "Context budget" : `Context · ${view}`)),
					...lines.slice(top, top + visibleRows).map((line) => ` ${truncateToWidth(line, bodyWidth)}`),
					theme.fg(
						"dim",
						`${top + 1}-${Math.min(lines.length, top + visibleRows)}/${lines.length}  ↑↓ scroll  PgUp/PgDn jump  Esc close`,
					),
				];
			},
			handleInput(input) {
				const page = Math.max(3, tui.terminal.rows - 8);
				if (matchesKey(input, Key.escape) || matchesKey(input, Key.enter)) return done();
				if (items) {
					if (matchesKey(input, Key.up)) selected = Math.max(0, selected - 1);
					else if (matchesKey(input, Key.down)) selected = Math.min(items.length - 1, selected + 1);
					else if (matchesKey(input, Key.pageUp)) selected = Math.max(0, selected - page);
					else if (matchesKey(input, Key.pageDown)) selected = Math.min(items.length - 1, selected + page);
					else if (matchesKey(input, Key.home)) selected = 0;
					else if (matchesKey(input, Key.end)) selected = Math.max(0, items.length - 1);
				} else if (matchesKey(input, Key.up)) top = Math.max(0, top - 1);
				else if (matchesKey(input, Key.down)) top += 1;
				else if (matchesKey(input, Key.pageUp)) top = Math.max(0, top - page);
				else if (matchesKey(input, Key.pageDown)) top += page;
				else if (matchesKey(input, Key.home)) top = 0;
				else if (matchesKey(input, Key.end)) top = Number.MAX_SAFE_INTEGER;
				tui.requestRender();
			},
		};
		return component;
	});
}

function listItems(view: ContextView, data: InspectorData): InspectorItem[] | undefined {
	if (view === "files")
		return (data.options.contextFiles ?? []).map((file) => ({
			title: file.path.split(/[\\/]/).pop() ?? file.path,
			meta: `${contextFileSource(file.path, data.options.cwd)}  ·  ~${estimateTextTokens(file.content).toLocaleString()} tokens`,
			detail: file.path,
		}));
	if (view === "skills")
		return (data.options.skills ?? []).map((skill) => ({
			title: skill.name,
			meta: `${skill.sourceInfo.scope}  ·  ~${estimateTextTokens(`${skill.name} ${skill.description}`).toLocaleString()} tokens${skill.disableModelInvocation ? "  ·  explicit only" : ""}`,
			detail: `${skill.filePath}\n${skill.description}`,
		}));
	if (view === "tools")
		return (data.options.selectedTools ?? []).map((name) => ({
			title: name,
			meta: `active  ·  ~${estimateTextTokens(`${name} ${data.options.toolSnippets?.[name] ?? ""}`).toLocaleString()} prompt tokens`,
			detail: data.options.toolSnippets?.[name] ?? "No prompt snippet",
		}));
	if (view === "messages")
		return data.messages.map((message, index) => {
			const serialized = JSON.stringify(message, null, 2);
			return {
				title: `${index + 1}. ${(message as { role?: string }).role ?? "message"}`,
				meta: `~${estimateTextTokens(serialized).toLocaleString()} serialized tokens`,
				detail: serialized,
			};
		});
	return undefined;
}

function renderInventory(
	view: ContextView,
	items: InspectorItem[],
	selected: number,
	top: number,
	visibleItems: number,
	width: number,
	theme: ThemeLike,
): string[] {
	const bodyWidth = Math.max(8, width - 2);
	const current = items[selected];
	const lines = [
		theme.fg("accent", theme.bold(`Context · ${view}`)),
		theme.fg("dim", `${items.length} loaded`),
		"",
	];
	if (items.length === 0) lines.push(theme.fg("muted", "Nothing loaded in this view."));
	for (let index = top; index < Math.min(items.length, top + visibleItems); index++) {
		const item = items[index];
		if (!item) continue;
		const active = index === selected;
		lines.push(
			truncateToWidth(
				`${active ? theme.fg("accent", "›") : " "} ${active ? theme.bold(item.title) : item.title}`,
				width,
			),
		);
		lines.push(truncateToWidth(`  ${theme.fg(active ? "muted" : "dim", item.meta)}`, width));
	}
	if (current) {
		lines.push("", theme.fg("accent", theme.bold("Selected")));
		for (const line of current.detail
			.split("\n")
			.flatMap((value) => wrapTextWithAnsi(value, bodyWidth))
			.slice(0, 4))
			lines.push(` ${theme.fg("muted", line)}`);
	}
	lines.push(
		"",
		theme.fg("dim", `↑↓ select  PgUp/PgDn jump  Home/End  Esc close  ·  ${selected + 1}/${items.length}`),
	);
	return lines;
}

function styledRaw(view: ContextView, content: string, theme: ThemeLike): string[] {
	const label = view === "system" ? "Effective system prompt" : "Last provider payload";
	return [
		theme.bold(label),
		theme.fg("dim", `~${estimateTextTokens(content).toLocaleString()} tokens`),
		"",
		...content.split("\n"),
	];
}

function renderSummary(lines: string[], width: number, theme: ThemeLike): string[] {
	const next = lines.find((line) => line.startsWith("next request estimate:")) ?? "";
	const match = next.match(/~([\d.,]+) \/ ([\d.,]+|unknown) tokens \(~([\d.]+|unknown)%\)/);
	const percent = match?.[3] === "unknown" ? 0 : Number(match?.[3] ?? 0);
	const barWidth = Math.max(12, Math.min(48, width - 2));
	const filled = Math.min(barWidth, Math.round((percent / 100) * barWidth));
	const color = percent >= 85 ? "error" : percent >= 65 ? "warning" : "success";
	const find = (prefix: string) =>
		lines.find((line) => line.startsWith(prefix))?.replace(`${prefix} `, "") ?? "";
	return [
		"",
		theme.bold("Next model request"),
		`${theme.fg(color, "█".repeat(filled))}${theme.fg("dim", "░".repeat(barWidth - filled))}`,
		theme.fg(color, theme.bold(match ? `~${match[1]} of ${match[2]} tokens  ·  ~${match[3]}%` : next)),
		theme.fg("muted", find("breakdown:")),
		"",
		theme.bold("What is loaded"),
		`${find("context files:")} files  ·  ${find("skills loaded:")} skills  ·  ${find("tools selected:")} tools`,
		"",
		theme.bold("Provider reading"),
		find("last measured:") === "not available yet"
			? theme.fg("dim", "Not measured yet — appears after the first model response")
			: `${find("last measured:")} in the last provider response`,
		"",
		theme.fg("accent", "/context files") + theme.fg("dim", "  instructions, source, and cost"),
		theme.fg("accent", "/context skills") + theme.fg("dim", " skills, source, and cost"),
		theme.fg("accent", "/context tools") + theme.fg("dim", "  active tools and cost"),
		theme.fg("accent", "/context messages") + theme.fg("dim", "  last model context"),
		theme.fg("accent", "/context payload") + theme.fg("dim", "   last provider body"),
		"",
		theme.fg("dim", "~ estimated; provider token usage is authoritative after a response."),
	];
}
