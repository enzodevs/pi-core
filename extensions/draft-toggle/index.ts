import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { lineWindow, sectionPanel, wrapped } from "../ui/sections.js";
import { DRAFT_ENTRY_TYPE, type PersistedDraftState, restoreDraft, toggleDraft } from "./state.js";

const WIDGET_KEY = "pi-core-draft";

export default function draftToggle(pi: ExtensionAPI): void {
	let draft: string | undefined;

	const update = (ctx: ExtensionContext) => {
		if (ctx.mode !== "tui") return;
		if (draft === undefined) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		ctx.ui.setWidget(
			WIDGET_KEY,
			(_tui, theme) => ({
				render(width) {
					const action = ctx.ui.getEditorText().length ? "swap" : "restore";
					const label =
						width >= 50
							? `Draft parked · Ctrl+Shift+S ${action} · Ctrl+Alt+D preview`
							: `Draft · ⇧Ctrl+S ${action}`;
					return [truncateToWidth(theme.fg("muted", label), Math.max(0, width), "")];
				},
				invalidate() {},
			}),
			{ placement: "belowEditor" },
		);
	};

	const restore = (ctx: ExtensionContext) => {
		draft = restoreDraft(ctx.sessionManager.getBranch());
		update(ctx);
	};

	pi.registerShortcut("ctrl+shift+s", {
		description: "Save, restore, or swap the current prompt draft",
		handler: (ctx) => {
			const editorText = ctx.ui.getEditorText();
			// Clipboard attachments belong to the live editor, not persisted text drafts.
			if (/\[Image \d+\]/u.test(editorText)) {
				ctx.ui.notify("Remove or submit attached images before parking this draft.", "warning");
				return;
			}
			const result = toggleDraft(draft, editorText);
			if (result.action === "empty") {
				ctx.ui.notify("No prompt draft to restore.", "info");
				return;
			}
			// Persist first: a storage failure must not clear the editor.
			pi.appendEntry<PersistedDraftState>(DRAFT_ENTRY_TYPE, { version: 1, draft: result.draft ?? null });
			draft = result.draft;
			ctx.ui.setEditorText(result.editorText);
			update(ctx);
		},
	});

	pi.registerShortcut("ctrl+alt+d", {
		description: "Preview the parked draft without restoring it",
		handler: async (ctx) => {
			if (ctx.mode !== "tui" || draft === undefined) {
				ctx.ui.notify("No parked draft to preview.", "info");
				return;
			}
			const snapshot = draft;
			await ctx.ui.custom<void>((tui, theme, _keys, done) => {
				let top = 0;
				let total = 0;
				let height = 1;
				return {
					render(width) {
						const lines = wrapped(snapshot, width);
						total = lines.length;
						height = Math.max(1, tui.terminal.rows - 2);
						const view = lineWindow(lines, height, top);
						top = view.top;
						return sectionPanel(
							[theme.fg("accent", "Parked draft · read only")],
							view.lines,
							[theme.fg("dim", "↑↓/Pg scroll · Home/End · Esc close · editor unchanged")],
							width,
							tui.terminal.rows,
						);
					},
					invalidate() {},
					handleInput(data) {
						if (matchesKey(data, Key.escape)) return done();
						if (matchesKey(data, Key.home)) top = 0;
						else if (matchesKey(data, Key.end)) top = Number.MAX_SAFE_INTEGER;
						else if (matchesKey(data, Key.up)) top = Math.max(0, top - 1);
						else if (matchesKey(data, Key.down)) top = Math.min(Math.max(0, total - height), top + 1);
						else if (matchesKey(data, Key.pageUp)) top = Math.max(0, top - height);
						else if (matchesKey(data, Key.pageDown)) top += height;
						tui.requestRender();
					},
				};
			});
		},
	});

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", (_event, ctx) => {
		draft = undefined;
		ctx.ui.setWidget(WIDGET_KEY, undefined);
	});
}
