import { describe, expect, it } from "vitest";
import { toggleDraft } from "../extensions/draft-toggle/state.js";

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
});
