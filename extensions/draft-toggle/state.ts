export type DraftToggleResult =
	| { action: "saved"; draft: string; editorText: "" }
	| { action: "restored"; draft: undefined; editorText: string }
	| { action: "empty"; draft: undefined; editorText: "" };

export function toggleDraft(draft: string | undefined, editorText: string): DraftToggleResult {
	if (editorText.length > 0) {
		return { action: "saved", draft: editorText, editorText: "" };
	}
	if (draft !== undefined) {
		return { action: "restored", draft: undefined, editorText: draft };
	}
	return { action: "empty", draft: undefined, editorText: "" };
}
