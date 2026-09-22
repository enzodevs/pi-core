import { stripVTControlCharacters } from "node:util";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import type { BackgroundProcessRun } from "./index.js";

type Theme = {
	fg(color: "accent" | "dim" | "muted" | "success" | "warning" | "error", text: string): string;
	bold(text: string): string;
};

function clean(text: string): string {
	return [...stripVTControlCharacters(text)]
		.filter(
			(character) =>
				character === "\n" ||
				character === "\t" ||
				(character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
		)
		.join("");
}

function duration(run: BackgroundProcessRun): string {
	const seconds = Math.max(0, Math.floor(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function clip(text: string, width: number): string {
	return truncateToWidth(clean(text), Math.max(1, width));
}

/** Render only TUI lines; never send process output or this view through pi.sendMessage. */
export function renderProcessView(
	runs: readonly BackgroundProcessRun[],
	selectedId: string | undefined,
	width: number,
	rows: number,
	theme: Theme,
): string[] {
	const w = Math.max(1, width - 2);
	const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
	const running = runs.filter((run) => run.status === "running").length;
	const lines: string[] = [
		` ${theme.fg("accent", theme.bold(clip("Background processes", w)))}  ${theme.fg("dim", clip(`${running} running · ${runs.length} recent`, Math.max(1, w - 23)))}`,
	];
	if (!selected) {
		lines.push("", ` ${theme.fg("muted", "No processes in this session yet.")}`);
	} else {
		const listHeight = Math.min(runs.length, Math.max(1, Math.floor((rows - 10) / 3)));
		const index = runs.indexOf(selected);
		const start = Math.min(Math.max(0, index - listHeight + 1), Math.max(0, runs.length - listHeight));
		lines.push(
			` ${theme.fg("dim", `Processes ${start + 1}–${Math.min(runs.length, start + listHeight)} of ${runs.length}`)}`,
		);
		for (const run of runs.slice(start, start + listHeight)) {
			const color = run.status === "running" ? "accent" : run.status === "complete" ? "success" : "warning";
			const label = `${run === selected ? "▸" : " "} ${run.id}  ${run.status}  ${duration(run)}  ${run.mode}`;
			lines.push(` ${theme.fg(color, clip(label, w))}`);
		}
		lines.push("", ` ${theme.fg("accent", theme.bold(`Process ${selected.id}`))}`);
		const meta = `${selected.status}${selected.exitCode !== undefined ? ` · exit ${selected.exitCode ?? "?"}` : ""} · ${duration(selected)}${selected.pid ? ` · PID ${selected.pid}` : ""}`;
		lines.push(` ${theme.fg("dim", clip(meta, w))}`);
		lines.push(` ${theme.fg("dim", "Directory: ")}${clip(selected.cwd, Math.max(1, w - 11))}`);
		lines.push(
			` ${theme.fg("dim", "Command:   ")}${clip(selected.command.replace(/\s+/gu, " "), Math.max(1, w - 11))}`,
		);
		lines.push(` ${theme.fg("dim", "Recent output (live):")}`);
		const available = Math.max(0, rows - lines.length - 3);
		if (available > 0) {
			const tail = selected.log?.tail(4096) ?? selected.output ?? "";
			const output = clean(tail).split("\n").slice(-available);
			for (const line of tail ? output : ["No output yet."]) {
				lines.push(` ${theme.fg(tail ? "muted" : "dim", clip(line, w))}`);
			}
		}
	}
	return [
		...lines.slice(0, Math.max(0, rows - 2)),
		"",
		` ${theme.fg("dim", clip("↑↓ choose · refreshes every second · Esc close · /stop <id> to stop", w))}`,
	];
}

export async function showProcesses(
	ctx: ExtensionCommandContext,
	getRuns: () => readonly BackgroundProcessRun[],
	initialId?: string,
): Promise<void> {
	let timer: ReturnType<typeof setInterval> | undefined;
	try {
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			let selectedId = initialId;
			timer = setInterval(() => tui.requestRender(), 1000);
			return {
				render(width) {
					return renderProcessView(getRuns(), selectedId, width, tui.terminal.rows, theme);
				},
				invalidate() {},
				handleInput(input) {
					if (matchesKey(input, Key.escape) || matchesKey(input, Key.enter)) return done();
					const runs = getRuns();
					const index = Math.max(
						0,
						runs.findIndex((run) => run.id === selectedId),
					);
					if (matchesKey(input, Key.up)) selectedId = runs[Math.max(0, index - 1)]?.id;
					else if (matchesKey(input, Key.down)) selectedId = runs[Math.min(runs.length - 1, index + 1)]?.id;
					else return;
					tui.requestRender();
				},
			};
		});
	} finally {
		if (timer) clearInterval(timer);
	}
}
