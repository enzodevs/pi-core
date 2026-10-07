import type { SessionEntry } from "@earendil-works/pi-coding-agent";

export const TRANSLATE_ENTRY = "pi-core-translate";

export function restoreEnabled(entries: readonly SessionEntry[]): boolean {
	for (let index = entries.length - 1; index >= 0; index--) {
		const entry = entries[index];
		if (entry?.type !== "custom" || entry.customType !== TRANSLATE_ENTRY) continue;
		const data = entry.data as { version?: unknown; enabled?: unknown } | undefined;
		return data?.version === 1 && data.enabled === true;
	}
	return false;
}
