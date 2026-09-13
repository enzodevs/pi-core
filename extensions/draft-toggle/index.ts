import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DRAFT_ENTRY_TYPE, type PersistedDraftState, restoreDraft, toggleDraft } from "./state.js";

export default function draftToggle(pi: ExtensionAPI): void {
	let draft: string | undefined;

	const persist = (value: string | undefined) => {
		pi.appendEntry<PersistedDraftState>(DRAFT_ENTRY_TYPE, { version: 1, draft: value ?? null });
	};

	const restore = (ctx: ExtensionContext) => {
		draft = restoreDraft(ctx.sessionManager.getBranch());
	};

	pi.registerShortcut("ctrl+shift+s", {
		description: "Save or restore the current prompt draft",
		handler: (ctx) => {
			const result = toggleDraft(draft, ctx.ui.getEditorText());
			if (result.action === "empty") {
				ctx.ui.notify("No prompt draft to restore.", "info");
				return;
			}

			if (result.action === "saved") {
				persist(result.draft);
				draft = result.draft;
				ctx.ui.setEditorText(result.editorText);
				ctx.ui.notify("Prompt draft saved.", "info");
				return;
			}

			ctx.ui.setEditorText(result.editorText);
			persist(undefined);
			draft = undefined;
			ctx.ui.notify("Prompt draft restored.", "info");
		},
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
}
