import type { ExtensionAPI, ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	type EditorTheme,
	Key,
	matchesKey,
	Text,
	truncateToWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import {
	type AskAnswer,
	type AskOption,
	AskUserQuestionParams,
	type AskUserQuestionResultDetails,
	answeredResult,
	cancelledResult,
	getOtherLabel,
	normalizeOptions,
	prepareQuestion,
	sortAnswers,
	unavailableResult,
} from "./core.js";
import { withSharedUiLock } from "./ui-lock.js";

interface DisplayOption extends AskOption {
	id: string;
	index?: number;
	isOther?: boolean;
	isSubmit?: boolean;
}

function createEditorTheme(theme: Theme): EditorTheme {
	return {
		borderColor: (text) => theme.fg("accent", text),
		selectList: {
			selectedPrefix: (text) => theme.fg("accent", text),
			selectedText: (text) => theme.fg("accent", text),
			description: (text) => theme.fg("muted", text),
			scrollInfo: (text) => theme.fg("dim", text),
			noMatch: (text) => theme.fg("warning", text),
		},
	};
}

function addWrapped(lines: string[], text: string, width: number, indent = ""): void {
	const contentWidth = Math.max(1, width - indent.length);
	for (const line of wrapTextWithAnsi(text, contentWidth)) {
		lines.push(truncateToWidth(`${indent}${line}`, width));
	}
}

function isCancelKey(data: string): boolean {
	return matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
}

async function askSingleChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer | null> {
	const allOptions: DisplayOption[] = [
		...options.map((option, index) => ({ ...option, id: `option:${index}`, index: index + 1 })),
		{ id: "other", label: getOtherLabel(options), value: "__other__", isOther: true },
	];

	return ctx.ui.custom<AskAnswer | null>((tui, theme, _keybindings, done) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const editor = new Editor(tui, createEditorTheme(theme));
		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (trimmed) done({ type: "other", label: trimmed, value: trimmed });
		};

		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};
		const handleInput = (data: string) => {
			if (editMode) {
				if (isCancelKey(data)) {
					editMode = false;
					editor.setText("");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) optionIndex = Math.max(0, optionIndex - 1);
			else if (matchesKey(data, Key.down)) optionIndex = Math.min(allOptions.length - 1, optionIndex + 1);
			else if (matchesKey(data, Key.enter)) {
				const selected = allOptions[optionIndex];
				if (selected.isOther) {
					editMode = true;
					editor.setText("");
				} else {
					if (selected.index === undefined) return;
					done({
						type: "option",
						label: selected.label,
						value: selected.value,
						index: selected.index,
					});
					return;
				}
			} else if (isCancelKey(data)) {
				done(null);
				return;
			} else return;
			refresh();
		};
		const render = (width: number): string[] => {
			if (width < 1) return [];
			if (cachedLines && cachedWidth === width) return cachedLines;
			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");
			for (let index = 0; index < allOptions.length; index++) {
				const option = allOptions[index];
				const focused = index === optionIndex;
				const prefix = focused ? theme.fg("accent", "> ") : "  ";
				const label = option.isOther ? option.label : `${option.index}. ${option.label}`;
				add(`${prefix}${theme.fg(focused ? "accent" : "text", label)}`);
				if (option.description) addWrapped(lines, theme.fg("muted", option.description), width, "     ");
			}
			lines.push("");
			if (editMode) {
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter submit • Esc back"));
			} else add(theme.fg("dim", " ↑↓ navigate • Enter select • Esc cancel"));
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		};

		return {
			get focused() {
				return editor.focused;
			},
			set focused(value: boolean) {
				editor.focused = value;
			},
			render,
			handleInput,
			invalidate() {
				cachedLines = undefined;
				cachedWidth = -1;
				editor.invalidate();
			},
		};
	});
}

async function askMultiChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer[] | null> {
	const choices: DisplayOption[] = options.map((option, index) => ({
		...option,
		id: `option:${index}`,
		index: index + 1,
	}));
	const allItems: DisplayOption[] = [
		...choices,
		{ id: "other", label: getOtherLabel(options), value: "__other__", isOther: true },
		{ id: "submit", label: "Submit", value: "__submit__", isSubmit: true },
	];

	return ctx.ui.custom<AskAnswer[] | null>((tui, theme, _keybindings, done) => {
		let optionIndex = 0;
		let editMode = false;
		let cachedLines: string[] | undefined;
		let cachedWidth = -1;
		const selected = new Map<string, AskAnswer>();
		const editor = new Editor(tui, createEditorTheme(theme));
		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			selected.set("other", { type: "other", label: trimmed, value: trimmed });
			editMode = false;
			refresh();
		};

		const refresh = () => {
			cachedLines = undefined;
			tui.requestRender();
		};
		const toggleOption = (item: DisplayOption) => {
			if (selected.has(item.id)) selected.delete(item.id);
			else {
				if (item.index === undefined) return;
				selected.set(item.id, {
					type: "option",
					label: item.label,
					value: item.value,
					index: item.index,
				});
			}
			refresh();
		};
		const handleInput = (data: string) => {
			if (editMode) {
				if (isCancelKey(data)) {
					editMode = false;
					editor.setText(selected.get("other")?.label ?? "");
					refresh();
					return;
				}
				editor.handleInput(data);
				refresh();
				return;
			}
			if (matchesKey(data, Key.up)) {
				optionIndex = Math.max(0, optionIndex - 1);
				refresh();
				return;
			}
			if (matchesKey(data, Key.down)) {
				optionIndex = Math.min(allItems.length - 1, optionIndex + 1);
				refresh();
				return;
			}
			const current = allItems[optionIndex];
			if (matchesKey(data, Key.space)) {
				if (current.isSubmit) return;
				if (current.isOther) {
					if (selected.has("other")) {
						selected.delete("other");
						refresh();
					} else {
						editMode = true;
						editor.setText("");
						refresh();
					}
				} else toggleOption(current);
				return;
			}
			if (matchesKey(data, Key.enter)) {
				if (current.isSubmit) {
					if (selected.size) done(sortAnswers([...selected.values()]));
				} else if (current.isOther) {
					editMode = true;
					editor.setText(selected.get("other")?.label ?? "");
					refresh();
				} else toggleOption(current);
				return;
			}
			if (isCancelKey(data)) done(null);
		};
		const render = (width: number): string[] => {
			if (width < 1) return [];
			if (cachedLines && cachedWidth === width) return cachedLines;
			const lines: string[] = [];
			const add = (text: string) => lines.push(truncateToWidth(text, width));
			add(theme.fg("accent", "─".repeat(width)));
			addWrapped(lines, theme.fg("text", ` ${question}`), width);
			if (context) {
				lines.push("");
				addWrapped(lines, theme.fg("muted", ` ${context}`), width);
			}
			lines.push("");
			for (let index = 0; index < allItems.length; index++) {
				const item = allItems[index];
				const focused = index === optionIndex;
				const prefix = focused ? theme.fg("accent", "> ") : "  ";
				if (item.isSubmit) {
					const label = selected.size ? `✓ Submit (${selected.size} selected)` : "○ Submit";
					add(`${prefix}${theme.fg(focused ? "accent" : selected.size ? "success" : "dim", label)}`);
					continue;
				}
				if (item.isOther) {
					const other = selected.get("other");
					const label = `${other ? "[x]" : "[ ]"} ${item.label}${other ? ` — ${other.label}` : ""}`;
					add(`${prefix}${theme.fg(focused ? "accent" : other ? "success" : "text", label)}`);
					continue;
				}
				const checked = selected.has(item.id);
				const label = `${checked ? "[x]" : "[ ]"} ${item.index}. ${item.label}`;
				add(`${prefix}${theme.fg(focused ? "accent" : checked ? "success" : "text", label)}`);
				if (item.description) addWrapped(lines, theme.fg("muted", item.description), width, "     ");
			}
			lines.push("");
			if (editMode) {
				add(theme.fg("muted", " Write your custom answer:"));
				for (const line of editor.render(Math.max(1, width - 2))) add(` ${line}`);
				lines.push("");
				add(theme.fg("dim", " Enter save • Esc back"));
			} else {
				if (!selected.size) add(theme.fg("warning", " Select at least one answer."));
				add(theme.fg("dim", " ↑↓ navigate • Space toggle • Enter edit/submit • Esc cancel"));
			}
			add(theme.fg("accent", "─".repeat(width)));
			cachedLines = lines;
			cachedWidth = width;
			return lines;
		};

		return {
			get focused() {
				return editor.focused;
			},
			set focused(value: boolean) {
				editor.focused = value;
			},
			render,
			handleInput,
			invalidate() {
				cachedLines = undefined;
				cachedWidth = -1;
				editor.invalidate();
			},
		};
	});
}

function renderOptions(value: unknown): AskOption[] {
	if (!Array.isArray(value)) return [];
	return normalizeOptions(
		value.filter(
			(option): option is { label: string; value?: string; description?: string } =>
				typeof option === "object" && option !== null && typeof option.label === "string",
		),
	);
}

export default function askUserQuestion(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask one clarifying, preference, or decision question and wait for the user. Supports free text, one choice, or multiple choices; every choice list includes Other.",
		parameters: AskUserQuestionParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const prepared = prepareQuestion(params);
			if (signal?.aborted) return cancelledResult(prepared);
			if (!ctx.hasUI) {
				return unavailableResult(prepared, "ask_user_question requires an interactive UI");
			}
			if (prepared.mode !== "text" && ctx.mode !== "tui") {
				return unavailableResult(prepared, "Choice questions require Pi's interactive TUI");
			}

			return withSharedUiLock(async () => {
				if (signal?.aborted) return cancelledResult(prepared);
				if (prepared.mode === "text") {
					const title = prepared.context ? `${prepared.question}\n\n${prepared.context}` : prepared.question;
					const answer = await ctx.ui.editor(title);
					if (answer === undefined) return cancelledResult(prepared);
					const value = answer.trim();
					return answeredResult(prepared, [{ type: "text", label: value, value }]);
				}
				if (prepared.mode === "single-select") {
					const answer = await askSingleChoice(ctx, prepared.question, prepared.context, prepared.options);
					return answer ? answeredResult(prepared, [answer]) : cancelledResult(prepared);
				}
				const answers = await askMultiChoice(ctx, prepared.question, prepared.context, prepared.options);
				return answers ? answeredResult(prepared, answers) : cancelledResult(prepared);
			});
		},
		renderCall(args, theme) {
			const options = renderOptions(args.options);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			text += theme.fg("muted", typeof args.question === "string" ? args.question : "");
			if (args.multiSelect) text += theme.fg("dim", " [multi-select]");
			if (options.length) {
				const labels = [...options.map((option) => option.label), getOtherLabel(options)].join(", ");
				text += `\n${theme.fg("dim", `  Options: ${labels}`)}`;
			}
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.status !== "answered") {
				return new Text(theme.fg("warning", details.message ?? details.status), 0, 0);
			}
			const lines = details.answers.map((answer) => {
				if (answer.type === "option") return `${theme.fg("success", "✓ ")}${answer.index}. ${answer.label}`;
				if (answer.type === "other") {
					return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${answer.label}`;
				}
				return `${theme.fg("success", "✓ ")}${answer.label || theme.fg("dim", "(empty response)")}`;
			});
			return new Text(lines.join("\n"), 0, 0);
		},
	});
}
