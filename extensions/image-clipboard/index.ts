import { readFileSync } from "node:fs";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type EditorTheme, Image, Text, type TUI } from "@earendil-works/pi-tui";
import { ClipboardImageDraft } from "./state.js";

function mimeTypeForPreview(filePath: string): string {
	const extension = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	return `image/${extension}`;
}

class ImageClipboardEditor extends CustomEditor {
	constructor(
		tui: TUI,
		theme: EditorTheme,
		private readonly imageKeybindings: KeybindingsManager,
		private readonly draft: ClipboardImageDraft,
		private readonly onDraftChange: () => void,
	) {
		super(tui, theme, imageKeybindings);
	}

	override setText(text: string): void {
		super.setText(text);
		this.reconcileDraft();
	}

	override insertTextAtCursor(text: string): void {
		const placeholder = this.draft.capture(text);
		super.insertTextAtCursor(placeholder ?? text);
		if (placeholder) this.onDraftChange();
	}

	override handleInput(data: string): void {
		const pasteStart = "\x1b[200~";
		const pasteEnd = "\x1b[201~";
		const pastedText =
			data.startsWith(pasteStart) && data.endsWith(pasteEnd)
				? data.slice(pasteStart.length, -pasteEnd.length).trim()
				: undefined;
		if (pastedText) {
			const placeholder = this.draft.capture(pastedText);
			if (placeholder) {
				super.insertTextAtCursor(placeholder);
				this.onDraftChange();
				return;
			}
		}

		if (this.imageKeybindings.matches(data, "tui.editor.deleteWordBackward")) {
			const cursor = this.getCursor();
			const beforeCursor = (this.getLines()[cursor.line] ?? "").slice(0, cursor.col);
			const match = beforeCursor.match(/\[Image \d+\]$/);
			if (match) {
				for (let index = 0; index < match[0].length; index += 1) super.handleInput("\x7f");
				this.draft.detach(match[0]);
				this.onDraftChange();
				return;
			}
		}
		super.handleInput(data);
		this.reconcileDraft();
	}

	private reconcileDraft(): void {
		const before = this.draft.previews().length;
		this.draft.reconcile(this.getText());
		if (this.draft.previews().length !== before) this.onDraftChange();
	}
}

export default function imageClipboard(pi: ExtensionAPI): void {
	let draft = new ClipboardImageDraft();
	let ownsEditor = false;

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const updatePreviews = () => {
			const previews = [...draft.previews()];
			if (previews.length === 0) {
				ctx.ui.setWidget("image-clipboard", undefined);
				return;
			}
			ctx.ui.setWidget("image-clipboard", (_tui, theme) => {
				const container = new Container();
				for (const preview of previews) {
					container.addChild(new Text(theme.fg("muted", preview.placeholder), 0, 0));
					try {
						container.addChild(
							new Image(
								readFileSync(preview.filePath).toString("base64"),
								mimeTypeForPreview(preview.filePath),
								{ fallbackColor: (text) => theme.fg("muted", text) },
								{ maxWidthCells: 40, maxHeightCells: 12, filename: preview.placeholder },
							),
						);
					} catch {
						container.addChild(new Text(theme.fg("warning", "Preview unavailable"), 0, 0));
					}
				}
				return container;
			});
		};

		if (ctx.ui.getEditorComponent()) {
			ctx.ui.notify("Image clipboard disabled because another extension owns the editor.", "warning");
			return;
		}
		ctx.ui.setEditorComponent(
			(tui, theme, keybindings) => new ImageClipboardEditor(tui, theme, keybindings, draft, updatePreviews),
		);
		ownsEditor = true;
	});

	pi.on("input", async (event, ctx) => {
		if (event.source !== "interactive") return { action: "continue" };

		try {
			const images = await draft.attachmentsFor(event.text);
			if (images.length === 0) return { action: "continue" };
			return {
				action: "transform",
				text: event.text,
				images: [...(event.images ?? []), ...images],
			};
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			ctx.ui.notify(`Could not attach clipboard image: ${message}`, "error");
			return { action: "handled" };
		} finally {
			await draft.reset();
			ctx.ui.setWidget("image-clipboard", undefined);
		}
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		ctx.ui.setWidget("image-clipboard", undefined);
		if (ownsEditor) ctx.ui.setEditorComponent(undefined);
		ownsEditor = false;
		await draft.reset();
		draft = new ClipboardImageDraft();
	});
}
