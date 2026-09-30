import { readFileSync } from "node:fs";
import { basename } from "node:path";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { CustomEditor, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type EditorTheme, Image, Text, type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import { ClipboardImageDraft } from "./state.js";
import { showImages } from "./ui.js";

function mimeTypeForPreview(filePath: string): string {
	const extension = filePath.slice(filePath.lastIndexOf(".") + 1).toLowerCase();
	if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
	return `image/${extension}`;
}

class ImageClipboardEditor extends CustomEditor {
	private submitting = false;

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
		// The base editor clears itself synchronously while submitting. Preserve
		// attachments until the input event converts them to image content.
		if (!this.submitting) this.reconcileDraft();
	}

	override insertTextAtCursor(text: string): void {
		const placeholder = this.draft.capture(text);
		super.insertTextAtCursor(placeholder ?? text);
		if (placeholder) this.onDraftChange();
	}

	override handleInput(data: string): void {
		if (this.imageKeybindings.matches(data, "tui.input.submit")) {
			this.submitting = true;
			try {
				super.handleInput(data);
			} finally {
				this.submitting = false;
			}
			return;
		}

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
	let refreshPreviews: (() => void) | undefined;

	pi.registerShortcut("ctrl+alt+i", {
		description: "Inspect or remove attached images without submitting the prompt",
		handler: async (ctx) => {
			if (ctx.mode !== "tui" || !ownsEditor || !refreshPreviews) return;
			if (draft.previews().length === 0) {
				ctx.ui.notify("No images attached.", "info");
				return;
			}
			await showImages(ctx, draft, refreshPreviews);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		const updatePreviews = () => {
			const previews = [...draft.previews()];
			if (previews.length === 0) {
				ctx.ui.setWidget("image-clipboard", undefined);
				return;
			}
			ctx.ui.setWidget("image-clipboard", (tui, theme) => {
				const container = new Container();
				const labels = previews
					.slice(0, 2)
					.map(
						(preview) =>
							`${preview.placeholder} ${basename(preview.filePath).replace(/[\p{Cc}\p{Cf}]/gu, "�")}`,
					);
				for (const [index, preview] of previews.slice(0, 2).entries()) {
					container.addChild(new Text(theme.fg("muted", labels[index]), 0, 0));
					try {
						container.addChild(
							new Image(
								readFileSync(preview.filePath).toString("base64"),
								mimeTypeForPreview(preview.filePath),
								{ fallbackColor: (text) => theme.fg("muted", text) },
								{ maxWidthCells: 40, maxHeightCells: 4, filename: preview.placeholder },
							),
						);
					} catch {
						container.addChild(new Text(theme.fg("warning", "Preview unavailable"), 0, 0));
					}
				}
				return {
					render(width) {
						const summary = `${previews.length} ${previews.length === 1 ? "image" : "images"} attached · Ctrl+Alt+I inspect/remove`;
						const header = truncateToWidth(theme.fg("accent", summary), Math.max(0, width), "…");
						const body =
							width < 36 || tui.terminal.rows < 18
								? labels.map((label) => truncateToWidth(theme.fg("muted", label), Math.max(0, width), "…"))
								: container.render(width);
						return [
							header,
							...body,
							...(previews.length > 2
								? [
										truncateToWidth(
											theme.fg("dim", `+${previews.length - 2} more · Ctrl+Alt+I shows all`),
											Math.max(0, width),
											"…",
										),
									]
								: []),
						];
					},
					invalidate() {
						container.invalidate();
					},
				};
			});
		};

		refreshPreviews = updatePreviews;
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
		refreshPreviews = undefined;
		await draft.reset();
		draft = new ClipboardImageDraft();
	});
}
