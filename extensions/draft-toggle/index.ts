import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { toggleDraft } from "./state.js";

export default function draftToggle(pi: ExtensionAPI): void {
	let draft: string | undefined;

	pi.registerShortcut("ctrl+shift+s", {
		description: "Save or restore the current prompt draft",
		handler: (ctx) => {
			const result = toggleDraft(draft, ctx.ui.getEditorText());
			draft = result.draft;
			if (result.action === "empty") {
				ctx.ui.notify("No prompt draft to restore.", "info");
				return;
			}
			ctx.ui.setEditorText(result.editorText);
			ctx.ui.notify(result.action === "saved" ? "Prompt draft saved." : "Prompt draft restored.", "info");
		},
	});
}
