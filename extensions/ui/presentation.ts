import {
	type Component,
	CURSOR_MARKER,
	stripTerminalSequences,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";

/** Presentation-only viewport. Never changes session entries or model-facing content. */
export function fitPanel(lines: readonly string[], width: number, rows: number): string[] {
	const w = Math.max(0, Math.floor(width));
	const height = Math.max(0, Math.floor(rows));
	if (!w || !height) return [];
	const content =
		lines.length > height ? lines.filter((line) => !/^[─━\s]*$/u.test(stripTerminalSequences(line))) : lines;
	const clipped = content.map((line) => truncateToWidth(line, w, "…"));
	if (clipped.length <= height) return clipped;
	if (height === 1) return [clipped[0] ?? ""];
	if (height === 2) return [clipped[0] ?? "", clipped.at(-1) ?? ""];
	// Keep the focused editor or selected row visible on short terminals.
	let anchor = content.findIndex((line) => line.includes(CURSOR_MARKER));
	if (anchor < 0) anchor = content.findIndex((line) => /^\s*[›▸>→]\s/u.test(stripTerminalSequences(line)));
	const available = height - 2;
	const start = Math.max(
		1,
		Math.min(Math.max(1, anchor - Math.floor(available / 2)), content.length - 1 - available),
	);
	return [clipped[0] ?? "", ...clipped.slice(start, start + available), clipped.at(-1) ?? ""];
}

/** Preserve input ownership and IME focus while bounding the custom screen to its viewport. */
export function responsivePanel<T extends Component>(
	component: T,
	tui: TUI,
): Component & { focused: boolean; dispose(): void } {
	const focusable = component as T & { focused?: boolean; dispose?(): void };
	return {
		get focused() {
			return focusable.focused ?? false;
		},
		set focused(value: boolean) {
			focusable.focused = value;
		},
		render(width) {
			return fitPanel(component.render(width), width, tui.terminal.rows);
		},
		handleInput(data) {
			component.handleInput?.(data);
		},
		invalidate() {
			component.invalidate();
		},
		dispose() {
			focusable.dispose?.();
		},
	};
}
