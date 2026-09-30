import type { BuildSystemPromptOptions, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { type Component, Key, matchesKey, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { displayText, lineWindow, sectionPanel, wrapped } from "../ui/sections.js";
import { type ContextView, contextFileSource, estimateTextTokens } from "./core.js";

interface InspectorData {
	options: BuildSystemPromptOptions;
	messages: readonly unknown[];
	contents: Record<ContextView, string>;
	skillModes: ReadonlyMap<string, "full" | "name" | "searchable" | "off">;
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
	initialView: ContextView,
	data: InspectorData,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
		let view = initialView;
		let top = 0;
		let selected = 0;
		let detailMode = false;
		let detailTop = 0;
		const component: Component = {
			invalidate() {},
			render(width) {
				const safeWidth = Math.max(1, width);
				const items = listItems(view, data);
				if (items && detailMode) {
					const current = items[selected];
					const lines = wrapped(current?.detail ?? "Nothing selected.", Math.max(1, width));
					const viewport = lineWindow(lines, Math.max(0, tui.terminal.rows - 3), detailTop);
					detailTop = viewport.top;
					return sectionPanel(
						[
							renderTabs(view, safeWidth, theme),
							theme.fg("accent", displayText(current?.title ?? "Details")),
						],
						viewport.lines,
						[theme.fg("dim", "↑↓/Pg scroll · Home/End · Esc list · Tab panel")],
						safeWidth,
						tui.terminal.rows,
					);
				}
				if (items) {
					const visibleItems = Math.max(1, Math.floor((tui.terminal.rows - 8) / 2));
					if (selected < top) top = selected;
					if (selected >= top + visibleItems) top = selected - visibleItems + 1;
					return sectionPanel(
						[renderTabs(view, safeWidth, theme), theme.fg("muted", panelPurpose(view))],
						renderInventory(view, items, selected, top, visibleItems, safeWidth, theme).slice(0, -2),
						[theme.fg("dim", "↑↓ select · Pg/Home/End · Enter details · Tab panel · Esc close")],
						safeWidth,
						tui.terminal.rows,
					);
				}
				const bodyWidth = Math.max(1, safeWidth);
				const content = displayText(data.contents[view]);
				const summary = view === "summary" ? content.split("\n") : undefined;
				const source = summary ? renderSummary(summary, bodyWidth, theme) : styledRaw(view, content, theme);
				const lines = source.flatMap((line) => wrapTextWithAnsi(line || " ", bodyWidth));
				const visibleRows = Math.max(0, tui.terminal.rows - 3);
				top = Math.min(top, Math.max(0, lines.length - visibleRows));
				return sectionPanel(
					[renderTabs(view, safeWidth, theme), theme.fg("muted", panelPurpose(view))],
					lines.slice(top, top + visibleRows),
					[
						theme.fg(
							"dim",
							`${top + 1}–${Math.min(lines.length, top + visibleRows)}/${lines.length} · ↑↓/Pg scroll · Tab panel · Esc close`,
						),
					],
					safeWidth,
					tui.terminal.rows,
				);
			},
			handleInput(input) {
				const page = Math.max(3, tui.terminal.rows - 8);
				if (matchesKey(input, Key.escape)) {
					if (detailMode) {
						detailMode = false;
						tui.requestRender();
						return;
					}
					return done();
				}
				if (detailMode && !matchesKey(input, Key.tab) && !matchesKey(input, Key.shift("tab"))) {
					if (matchesKey(input, Key.home)) detailTop = 0;
					else if (matchesKey(input, Key.end)) detailTop = Number.MAX_SAFE_INTEGER;
					else if (matchesKey(input, Key.up)) detailTop = Math.max(0, detailTop - 1);
					else if (matchesKey(input, Key.down)) detailTop += 1;
					else if (matchesKey(input, Key.pageUp)) detailTop = Math.max(0, detailTop - page);
					else if (matchesKey(input, Key.pageDown)) detailTop += page;
					tui.requestRender();
					return;
				}
				if (matchesKey(input, Key.enter) && listItems(view, data)?.length) {
					detailMode = true;
					detailTop = 0;
					tui.requestRender();
					return;
				}
				if (matchesKey(input, Key.tab) || matchesKey(input, Key.shift("tab"))) {
					const direction = matchesKey(input, Key.shift("tab")) ? -1 : 1;
					const index = CONTEXT_PANELS.indexOf(view);
					view =
						CONTEXT_PANELS[(index + direction + CONTEXT_PANELS.length) % CONTEXT_PANELS.length] ?? "summary";
					top = 0;
					selected = 0;
					detailMode = false;
					detailTop = 0;
					tui.requestRender();
					return;
				}
				const items = listItems(view, data);
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

const CONTEXT_PANELS: readonly ContextView[] = [
	"summary",
	"files",
	"skills",
	"tools",
	"messages",
	"system",
	"payload",
];

function panelPurpose(view: ContextView): string {
	return {
		summary: "What occupies context?",
		files: "Which files are included?",
		skills: "Which skills can the model see?",
		tools: "Which tools are active?",
		messages: "What conversation is included?",
		system: "What instructions are sent?",
		payload: "What was sent to the provider?",
	}[view];
}

function renderTabs(view: ContextView, width: number, theme: ThemeLike): string {
	const labels: Record<ContextView, string> = {
		summary: "Budget",
		files: "Files",
		skills: "Skills",
		tools: "Tools",
		messages: "Conversation",
		system: "Instructions",
		payload: "Provider payload",
	};
	const focused = theme.fg("accent", theme.bold(`[${labels[view]}]`));
	const rest = CONTEXT_PANELS.filter((panel) => panel !== view)
		.map((panel) => theme.fg("dim", labels[panel]))
		.join(" · ");
	return truncateToWidth(
		`${focused} ${CONTEXT_PANELS.indexOf(view) + 1}/${CONTEXT_PANELS.length} · ${rest}`,
		Math.max(0, width),
		"…",
	);
}

function listItems(view: ContextView, data: InspectorData): InspectorItem[] | undefined {
	if (view === "files")
		return (data.options.contextFiles ?? []).map((file) => ({
			title: file.path.split(/[\\/]/).pop() ?? file.path,
			meta: `${contextFileSource(file.path, data.options.cwd)}  ·  ~${estimateTextTokens(file.content).toLocaleString()} tokens`,
			detail: file.path,
		}));
	if (view === "skills")
		return (data.options.skills ?? [])
			.filter((skill) => {
				const mode = data.skillModes.get(skill.name) ?? "full";
				return !skill.disableModelInvocation && (mode === "full" || mode === "name");
			})
			.map((skill) => {
				const mode = data.skillModes.get(skill.name) ?? "full";
				return {
					title: skill.name,
					meta: `${mode}  ·  ${skill.sourceInfo.scope}  ·  ~${estimateTextTokens(mode === "name" ? skill.name : `${skill.name} ${skill.description}`).toLocaleString()} tokens`,
					detail: `${skill.filePath}\n${mode === "name" ? "Only the name is in model context; instructions remain unloaded." : skill.description}`,
				};
			});
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
		theme.fg(
			"dim",
			view === "skills"
				? `${items.length} model-visible · searchable/off excluded`
				: `${items.length} loaded`,
		),
		"",
	];
	if (items.length === 0) lines.push(theme.fg("muted", "Nothing loaded in this view."));
	for (let index = top; index < Math.min(items.length, top + visibleItems); index++) {
		const item = items[index];
		if (!item) continue;
		const active = index === selected;
		lines.push(
			truncateToWidth(
				`${active ? theme.fg("accent", "›") : " "} ${active ? theme.bold(displayText(item.title)) : displayText(item.title)}`,
				width,
			),
		);
		lines.push(truncateToWidth(`  ${theme.fg(active ? "muted" : "dim", displayText(item.meta))}`, width));
	}
	if (current) {
		lines.push("", theme.fg("accent", theme.bold("Selected")));
		for (const line of displayText(current.detail)
			.split("\n")
			.flatMap((value) => wrapTextWithAnsi(value, bodyWidth))
			.slice(0, 1))
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
		theme.fg("accent", "Tab / Shift+Tab") + theme.fg("dim", "  move between context panels"),
		theme.fg("accent", "↑ / ↓") + theme.fg("dim", "              select an item or scroll content"),
		"",
		theme.fg("dim", "~ estimated; provider token usage is authoritative after a response."),
	];
}
