import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, Editor, Key, matchesKey, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { displayText, lineWindow, sectionPanel, wrapped } from "../ui/sections.js";
import { type AskAnswer, type AskOption, getOtherLabel, sortAnswers } from "./core.js";

interface Choice extends AskOption {
	id: string;
	index?: number;
	other?: boolean;
	submit?: boolean;
}

async function askChoices(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
	multiple: boolean,
): Promise<AskAnswer[] | null> {
	const choices: Choice[] = [
		...options.map((option, index) => ({ ...option, id: String(index), index: index + 1 })),
		{ id: "other", label: getOtherLabel(options), value: "__other__", other: true },
		...(multiple ? [{ id: "submit", label: "Submit", value: "__submit__", submit: true }] : []),
	];
	return ctx.ui.custom<AskAnswer[] | null>((tui, theme, _keys, done) => {
		let selectedIndex = 0;
		let editing = false;
		let reading = false;
		let focused = false;
		let otherDraft: string | undefined;
		let notice: string | undefined;
		let readTop = 0;
		let choiceTop = 0;
		let readHeight = 1;
		let readTotal = 0;
		const answers = new Map<string, AskAnswer>();
		const editor = new Editor(tui, {
			borderColor: (text) => theme.fg("accent", text),
			selectList: {
				selectedPrefix: (text) => theme.fg("accent", text),
				selectedText: (text) => theme.fg("accent", text),
				description: (text) => theme.fg("muted", text),
				scrollInfo: (text) => theme.fg("dim", text),
				noMatch: (text) => theme.fg("warning", text),
			},
		});
		const refresh = () => {
			editor.focused = focused && editing;
			tui.requestRender();
		};
		const submit = () => {
			if (answers.size) done(sortAnswers([...answers.values()]));
			else notice = "Select at least one answer before submitting.";
		};
		editor.onSubmit = (value) => {
			const trimmed = value.trim();
			if (!trimmed) return;
			otherDraft = trimmed;
			const answer: AskAnswer = { type: "other", label: trimmed, value: trimmed };
			if (!multiple) done([answer]);
			else {
				answers.set("other", answer);
				editing = false;
				refresh();
			}
		};
		const toggle = (choice: Choice) => {
			if (choice.submit) {
				submit();
				return;
			}
			if (choice.other) {
				editing = true;
				editor.setText(otherDraft ?? answers.get("other")?.label ?? "");
				refresh();
				return;
			}
			if (choice.index === undefined) return;
			const answer: AskAnswer = {
				type: "option",
				label: choice.label,
				value: choice.value,
				index: choice.index,
			};
			if (!multiple) {
				done([answer]);
				return;
			}
			if (answers.has(choice.id)) answers.delete(choice.id);
			else answers.set(choice.id, answer);
		};
		return {
			get focused() {
				return focused;
			},
			set focused(value: boolean) {
				focused = value;
				editor.focused = value && editing;
			},
			invalidate() {
				editor.invalidate();
			},
			render(width) {
				if (width < 1) return [];
				const rows = tui.terminal.rows;
				const choice = choices[selectedIndex];
				const title = editing
					? "Write your answer · Other"
					: multiple
						? `Choose multiple · ${answers.size} selected`
						: "Choose one answer";
				const prompt = [
					...wrapped(question, width),
					...(context ? wrapped(context, width).map((line) => theme.fg("muted", line)) : []),
				];
				if (reading) {
					const details = [
						...prompt,
						theme.bold("Selected alternative"),
						...wrapped(choice.label, width),
						...(choice.description ? wrapped(choice.description, width) : []),
					];
					readHeight = Math.max(1, rows - 2);
					readTotal = details.length;
					const view = lineWindow(details, readHeight, readTop);
					readTop = view.top;
					return sectionPanel(
						[theme.fg("accent", "Question & context")],
						view.lines,
						[
							theme.fg(
								"dim",
								`${view.top + 1}–${view.top + view.lines.length}/${view.total} · ↑↓/Pg scroll · Tab/Esc answers`,
							),
						],
						width,
						rows,
					);
				}
				const promptHeight = Math.max(1, Math.min(4, Math.floor(rows / 4)));
				const header = [theme.fg("accent", theme.bold(title)), ...prompt.slice(0, promptHeight)];
				const footer = [
					theme.fg(
						notice ? "warning" : "dim",
						notice ??
							(editing
								? `Enter ${multiple ? "save" : "submit"} answer · Esc back (keeps text)`
								: multiple
									? "↑↓ choose · Space toggle · Ctrl+Enter submit · Tab context · Esc cancel"
									: "↑↓ choose · Enter select · Tab context · Esc cancel"),
					),
				];
				const height = Math.max(0, rows - header.length - footer.length);
				if (editing) {
					const lines = editor.render(width);
					const cursor = lines.findIndex((line) => line.includes(CURSOR_MARKER));
					return sectionPanel(
						header,
						lineWindow(lines, height, 0, cursor >= 0 ? cursor : lines.length - 1).lines,
						footer,
						width,
						rows,
					);
				}
				const body: string[] = [];
				let anchor = 0;
				for (const [index, item] of choices.entries()) {
					if (index === selectedIndex) anchor = body.length;
					const checked = answers.has(item.id);
					const label = item.submit
						? `Submit (${answers.size} selected)`
						: `${multiple ? (checked ? "[x] " : "[ ] ") : ""}${item.index ? `${item.index}. ` : ""}${displayText(item.label)}${item.other && checked ? ` — ${displayText(answers.get("other")?.label ?? "")}` : ""}`;
					const line = `${index === selectedIndex ? "› " : "  "}${label}`;
					body.push(theme.fg(index === selectedIndex ? "accent" : checked ? "success" : "text", line));
					if (item.description)
						body.push(
							...wrapTextWithAnsi(displayText(item.description), Math.max(1, width - 2))
								.slice(0, 2)
								.map((text) => theme.fg("muted", `  ${text}`)),
						);
				}
				const view = lineWindow(body, height, choiceTop, anchor);
				choiceTop = view.top;
				return sectionPanel(header, view.lines, footer, width, rows);
			},
			handleInput(data) {
				const cancel = matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"));
				if (editing) {
					if (cancel) {
						otherDraft = editor.getText();
						editing = false;
					} else editor.handleInput(data);
					refresh();
					return;
				}
				if (reading) {
					if (cancel || matchesKey(data, Key.tab)) reading = false;
					else if (matchesKey(data, Key.home)) readTop = 0;
					else if (matchesKey(data, Key.end)) readTop = Number.MAX_SAFE_INTEGER;
					else if (matchesKey(data, Key.up)) readTop = Math.max(0, readTop - 1);
					else if (matchesKey(data, Key.down))
						readTop = Math.min(Math.max(0, readTotal - readHeight), readTop + 1);
					else if (matchesKey(data, Key.pageUp)) readTop = Math.max(0, readTop - readHeight);
					else if (matchesKey(data, Key.pageDown)) readTop += readHeight;
					refresh();
					return;
				}
				notice = undefined;
				if (cancel) {
					done(null);
					return;
				}
				if (matchesKey(data, Key.tab)) {
					reading = true;
					readTop = 0;
				} else if (multiple && matchesKey(data, Key.ctrl("enter"))) submit();
				else if (matchesKey(data, Key.home)) selectedIndex = 0;
				else if (matchesKey(data, Key.end)) selectedIndex = choices.length - 1;
				else if (matchesKey(data, Key.up)) selectedIndex = Math.max(0, selectedIndex - 1);
				else if (matchesKey(data, Key.down)) selectedIndex = Math.min(choices.length - 1, selectedIndex + 1);
				else if (matchesKey(data, Key.pageUp)) selectedIndex = Math.max(0, selectedIndex - 5);
				else if (matchesKey(data, Key.pageDown))
					selectedIndex = Math.min(choices.length - 1, selectedIndex + 5);
				else if (matchesKey(data, Key.enter) || (multiple && matchesKey(data, Key.space))) {
					const choice = choices[selectedIndex];
					if (multiple && choice.other && matchesKey(data, Key.space) && answers.has("other"))
						answers.delete("other");
					else toggle(choice);
				}
				refresh();
			},
		};
	});
}

export async function askSingleChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer | null> {
	return (await askChoices(ctx, question, context, options, false))?.[0] ?? null;
}
export async function askMultiChoice(
	ctx: ExtensionContext,
	question: string,
	context: string | undefined,
	options: AskOption[],
): Promise<AskAnswer[] | null> {
	return askChoices(ctx, question, context, options, true);
}
