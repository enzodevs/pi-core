export const DRAFT_ENTRY_TYPE = "pi-core-draft-toggle";

export interface PersistedDraftState {
	version: 1;
	draft: string | null;
}

interface DraftEntry {
	type: string;
	customType?: string;
	data?: unknown;
}

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

export function restoreDraft(entries: readonly DraftEntry[]): string | undefined {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry.type !== "custom" || entry.customType !== DRAFT_ENTRY_TYPE) continue;
		if (!entry.data || typeof entry.data !== "object") return undefined;
		const state = entry.data as Partial<PersistedDraftState>;
		return state.version === 1 && typeof state.draft === "string" ? state.draft : undefined;
	}
	return undefined;
}
