import { stripTerminalSequences, truncateToWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";

export function displayText(text: string): string {
	return stripTerminalSequences(text).replace(/[\p{Cc}\p{Cf}]/gu, (character) =>
		character === "\n" || character === "\t" ? character : "�",
	);
}

export function wrapped(text: string, width: number): string[] {
	return displayText(text)
		.split("\n")
		.flatMap((line) => wrapTextWithAnsi(line || " ", Math.max(1, width)));
}

/** Explicit content viewport: callers retain task-specific headers and controls. */
export function lineWindow(
	lines: readonly string[],
	height: number,
	top = 0,
	anchor?: number,
): { lines: string[]; top: number; total: number } {
	const size = Math.max(0, Math.floor(height));
	let start = Math.max(0, Math.min(top, Math.max(0, lines.length - size)));
	if (anchor !== undefined && size > 0) {
		if (anchor < start) start = anchor;
		if (anchor >= start + size) start = anchor - size + 1;
	}
	return { lines: lines.slice(start, start + size), top: start, total: lines.length };
}

export function sectionPanel(
	header: readonly string[],
	body: readonly string[],
	footer: readonly string[],
	width: number,
	rows: number,
): string[] {
	if (width <= 0 || rows <= 0) return [];
	const height = Math.floor(rows);
	if (height === 1) return [truncateToWidth(header[0] ?? footer[0] ?? "", width, "…")];
	const bottom = footer.slice(-Math.min(footer.length, Math.max(1, Math.floor(height / 4))));
	const head = header.slice(0, Math.max(0, height - bottom.length - 1));
	const available = Math.max(0, height - head.length - bottom.length);
	return [...head, ...body.slice(0, available), ...bottom].map((line) => truncateToWidth(line, width, "…"));
}
