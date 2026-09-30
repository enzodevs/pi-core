import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import draftToggle from "../extensions/draft-toggle/index.js";
import { DRAFT_ENTRY_TYPE, restoreDraft, toggleDraft } from "../extensions/draft-toggle/state.js";

describe("draft TUI wiring", () => {
	it("uses only custom state and widgets and preserves the editor if persistence fails", () => {
		let shortcut: ((ctx: ExtensionContext) => void) | undefined;
		const appendEntry = vi.fn();
		const setEditorText = vi.fn();
		const setWidget = vi.fn();
		const notify = vi.fn();
		draftToggle({
			registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => void }) => {
				if (key === "ctrl+shift+s") shortcut = options.handler;
			},
			appendEntry,
			on: vi.fn(),
		} as unknown as ExtensionAPI);
		if (!shortcut) throw new Error("Missing shortcut");
		const ctx = {
			mode: "tui",
			ui: { getEditorText: () => "prompt", setEditorText, setWidget, notify },
		} as unknown as ExtensionContext;
		appendEntry.mockImplementationOnce(() => {
			throw new Error("disk full");
		});
		expect(() => shortcut?.(ctx)).toThrow("disk full");
		expect(setEditorText).not.toHaveBeenCalled();
		shortcut(ctx);
		expect(appendEntry).toHaveBeenLastCalledWith(DRAFT_ENTRY_TYPE, { version: 1, draft: "prompt" });
		expect(setEditorText).toHaveBeenCalledWith("");
		expect(setWidget).toHaveBeenCalled();
		expect(notify).not.toHaveBeenCalled();
	});

	it("does not orphan clipboard placeholders when parking a prompt", () => {
		let shortcut: ((ctx: ExtensionContext) => void) | undefined;
		const appendEntry = vi.fn();
		const setEditorText = vi.fn();
		const notify = vi.fn();
		draftToggle({
			registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => void }) => {
				if (key === "ctrl+shift+s") shortcut = options.handler;
			},
			appendEntry,
			on: vi.fn(),
		} as unknown as ExtensionAPI);
		shortcut?.({
			mode: "tui",
			ui: { getEditorText: () => "Look at [Image 01]", setEditorText, notify },
		} as unknown as ExtensionContext);
		expect(notify).toHaveBeenCalledWith(expect.stringContaining("attached images"), "warning");
		expect(appendEntry).not.toHaveBeenCalled();
		expect(setEditorText).not.toHaveBeenCalled();
	});
});

describe("prompt draft toggle", () => {
	it("saves the complete editor text and clears the editor", () => {
		expect(toggleDraft(undefined, "first line\nsecond line")).toEqual({
			action: "saved",
			draft: "first line\nsecond line",
			editorText: "",
		});
	});

	it("restores a saved draft into an empty editor", () => {
		expect(toggleDraft("saved prompt", "")).toEqual({
			action: "restored",
			draft: undefined,
			editorText: "saved prompt",
		});
	});

	it("reports an empty state when there is nothing to restore", () => {
		expect(toggleDraft(undefined, "")).toEqual({
			action: "empty",
			draft: undefined,
			editorText: "",
		});
	});

	it("swaps drafts without losing either prompt", () => {
		const first = toggleDraft("old prompt", "new prompt");
		expect(first).toEqual({ action: "swapped", draft: "new prompt", editorText: "old prompt" });
		expect(toggleDraft(first.draft, first.editorText)).toEqual({
			action: "swapped",
			draft: "old prompt",
			editorText: "new prompt",
		});
	});

	it("restores the latest persisted draft from the active branch", () => {
		expect(
			restoreDraft([
				{ type: "custom", customType: DRAFT_ENTRY_TYPE, data: { version: 1, draft: "old" } },
				{ type: "message" },
				{ type: "custom", customType: DRAFT_ENTRY_TYPE, data: { version: 1, draft: "latest" } },
			]),
		).toBe("latest");
	});

	it("honors a persisted clear marker", () => {
		expect(
			restoreDraft([
				{ type: "custom", customType: DRAFT_ENTRY_TYPE, data: { version: 1, draft: "saved" } },
				{ type: "custom", customType: DRAFT_ENTRY_TYPE, data: { version: 1, draft: null } },
			]),
		).toBeUndefined();
	});

	it("does not revive an older draft when the latest state is malformed", () => {
		expect(
			restoreDraft([
				{ type: "custom", customType: DRAFT_ENTRY_TYPE, data: { version: 1, draft: "saved" } },
				{ type: "custom", customType: DRAFT_ENTRY_TYPE, data: { version: 1, draft: 42 } },
			]),
		).toBeUndefined();
	});
});
