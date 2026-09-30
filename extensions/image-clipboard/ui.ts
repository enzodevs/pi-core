import { readFile } from "node:fs/promises";
import { basename, extname } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Image, Key, matchesKey, SelectList } from "@earendil-works/pi-tui";
import { displayText, lineWindow, sectionPanel, wrapped } from "../ui/sections.js";
import type { ClipboardImageDraft } from "./state.js";

export async function showImages(
	ctx: ExtensionContext,
	draft: ClipboardImageDraft,
	onChange: () => void,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _keys, done) => {
		let image: Image | undefined;
		let message = "";
		let generation = 0;
		let disposed = false;
		let confirming = false;
		let details = false;
		let top = 0;
		let total = 0;
		let height = 1;
		const load = async (placeholder: string) => {
			const token = ++generation;
			image = undefined;
			message = "Loading preview…";
			const preview = draft.previews().find((item) => item.placeholder === placeholder);
			if (!preview) return;
			try {
				const data = await readFile(preview.filePath);
				if (token !== generation || disposed) return;
				const extension = extname(preview.filePath).slice(1).toLowerCase();
				image = new Image(
					data.toString("base64"),
					extension === "jpg" || extension === "jpeg" ? "image/jpeg" : `image/${extension}`,
					{ fallbackColor: (text) => theme.fg("muted", text) },
					{ maxWidthCells: 60, maxHeightCells: 6, filename: displayText(basename(preview.filePath)) },
				);
				message = "";
			} catch {
				if (token === generation) message = "Preview unavailable · file remains attached until submission.";
			}
			if (!disposed) tui.requestRender();
		};
		const createList = () => {
			const list = new SelectList(
				draft.previews().map((preview) => ({
					value: preview.placeholder,
					label: `${preview.placeholder} ${displayText(basename(preview.filePath))}`,
				})),
				4,
				{
					selectedPrefix: (text) => theme.fg("accent", text),
					selectedText: (text) => theme.fg("accent", text),
					description: (text) => theme.fg("muted", text),
					scrollInfo: (text) => theme.fg("dim", text),
					noMatch: (text) => theme.fg("muted", text),
				},
			);
			list.onSelectionChange = (item) => {
				top = 0;
				void load(item.value);
			};
			return list;
		};
		let list = createList();
		const initial = list.getSelectedItem();
		if (initial) void load(initial.value);
		return {
			render(width) {
				const header = [
					theme.fg("accent", `Attached images · ${draft.previews().length} · originals are never deleted`),
				];
				const footer = [
					theme.fg(
						confirming ? "warning" : "dim",
						confirming
							? "Remove this attachment? Enter confirm · Esc keep"
							: "↑↓ images · V path/details · D remove · Esc close",
					),
				];
				const preview = draft.previews().find((item) => item.placeholder === list.getSelectedItem()?.value);
				if (!preview) return sectionPanel(header, ["No images attached."], footer, width, tui.terminal.rows);
				if (details) {
					const lines = wrapped(
						`${preview.placeholder}\n${preview.filePath}\nRemoving detaches the image from this prompt only; the original file is untouched.`,
						width,
					);
					height = Math.max(1, tui.terminal.rows - 2);
					total = lines.length;
					const view = lineWindow(lines, height, top);
					top = view.top;
					return sectionPanel(
						header,
						view.lines,
						[
							theme.fg(
								"dim",
								confirming ? "Enter remove · Esc keep" : "↑↓/Pg scroll · V/Esc images · D remove",
							),
						],
						width,
						tui.terminal.rows,
					);
				}
				const options = list.render(width);
				const anchor = options.findIndex((line) => displayText(line).startsWith("→ "));
				const available = Math.max(1, tui.terminal.rows - 2);
				const visible = lineWindow(options, Math.min(4, available), 0, Math.max(0, anchor));
				const body = [
					...visible.lines,
					...wrapped(preview.filePath, width)
						.slice(0, 2)
						.map((line) => theme.fg("muted", line)),
				];
				if (message) body.push(...wrapped(message, width));
				else if (image) {
					const imageLines = image.render(width);
					// Never crop a native image's terminal escape stream/allocated rows.
					if (imageLines.length <= available - body.length) body.push(...imageLines);
					else body.push(theme.fg("dim", "Enlarge terminal for preview · V full path"));
				}
				return sectionPanel(header, body, footer, width, tui.terminal.rows);
			},
			invalidate() {
				list.invalidate();
				image?.invalidate();
			},
			dispose() {
				disposed = true;
				generation++;
			},
			handleInput(data) {
				if (confirming) {
					if (matchesKey(data, Key.escape)) confirming = false;
					else if (matchesKey(data, Key.enter)) {
						const placeholder = list.getSelectedItem()?.value;
						if (placeholder) {
							draft.detach(placeholder);
							ctx.ui.setEditorText(ctx.ui.getEditorText().replaceAll(placeholder, ""));
							onChange();
						}
						confirming = false;
						top = 0;
						list = createList();
						const current = list.getSelectedItem();
						if (current) void load(current.value);
						else {
							generation++;
							image = undefined;
						}
					}
				} else if (data === "d" || data === "D") confirming = !!list.getSelectedItem();
				else if (data === "v" || data === "V") {
					details = !details;
					top = 0;
				} else if (matchesKey(data, Key.escape)) {
					if (details) details = false;
					else return done();
				} else if (details) {
					if (matchesKey(data, Key.home)) top = 0;
					else if (matchesKey(data, Key.end)) top = Number.MAX_SAFE_INTEGER;
					else if (matchesKey(data, Key.up)) top = Math.max(0, top - 1);
					else if (matchesKey(data, Key.down)) top = Math.min(Math.max(0, total - height), top + 1);
					else if (matchesKey(data, Key.pageUp)) top = Math.max(0, top - height);
					else if (matchesKey(data, Key.pageDown)) top += height;
				} else list.handleInput(data);
				tui.requestRender();
			},
		};
	});
}
