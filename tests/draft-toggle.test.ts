import { describe, expect, it } from "vitest";
import { DRAFT_ENTRY_TYPE, restoreDraft, toggleDraft } from "../extensions/draft-toggle/state.js";

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

	it("replaces the saved draft when the editor contains new text", () => {
		expect(toggleDraft("old prompt", "new prompt")).toEqual({
			action: "saved",
			draft: "new prompt",
			editorText: "",
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
