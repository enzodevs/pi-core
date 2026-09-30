import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey, truncateToWidth } from "@earendil-works/pi-tui";
import { displayText, lineWindow, sectionPanel, wrapped } from "../ui/sections.js";
import type { BackgroundProcessRun } from "./index.js";

type Theme = {
	fg(color: "accent" | "dim" | "muted" | "success" | "warning" | "error", text: string): string;
	bold(text: string): string;
};
type Pane = "overview" | "logs" | "details";
interface ProcessViewState {
	pane?: Pane;
	top?: number;
	confirming?: boolean;
	notice?: string;
}

function duration(run: BackgroundProcessRun): string {
	const seconds = Math.max(0, Math.floor(((run.finishedAt ?? Date.now()) - run.startedAt) / 1000));
	return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}
function logLines(run: BackgroundProcessRun, width: number): string[] {
	const tail = run.log?.tail(32 * 1024) ?? run.output ?? "";
	return wrapped(tail || "No output yet.", width);
}

/** Display-only: no logs, controls or feedback are sent to the model. */
export function renderProcessView(
	runs: readonly BackgroundProcessRun[],
	selectedId: string | undefined,
	width: number,
	rows: number,
	theme: Theme,
	state: ProcessViewState = {},
): string[] {
	const w = Math.max(1, width);
	const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
	const pane = state.pane ?? "overview";
	const running = runs.filter((run) => run.status === "running").length;
	const header = [
		theme.fg("accent", theme.bold("Background processes")),
		theme.fg("dim", `${running} running · ${runs.length} recent · ${pane}`),
	];
	const footer = [
		theme.fg(
			state.confirming ? "warning" : "dim",
			state.confirming
				? "Stop this process? Enter confirm · Esc keep running"
				: (state.notice ??
						(pane === "overview"
							? "↑↓ choose · Tab logs/details · S stop · Esc close"
							: "↑↓ scroll · PgUp/PgDn · Home/End · Tab view · S stop · Esc close")),
		),
	];
	if (!selected)
		return sectionPanel(
			header,
			[theme.fg("muted", "No processes in this session yet.")],
			footer,
			width,
			rows,
		);
	if (pane !== "overview")
		header[1] = theme.fg("muted", `${pane} · ${displayText(selected.command).replace(/\s+/gu, " ")}`);
	const meta = `${selected.status} · ${duration(selected)}${selected.exitCode !== undefined ? ` · exit ${selected.exitCode ?? "?"}` : ""}`;
	header.push(
		theme.fg(
			selected.status === "running" ? "accent" : selected.status === "complete" ? "success" : "warning",
			meta,
		),
	);
	let body: string[];
	if (pane === "logs") {
		const lines = logLines(selected, w);
		const height = Math.max(0, rows - header.length - footer.length - 1);
		const view = lineWindow(lines, height, state.top ?? Number.MAX_SAFE_INTEGER);
		header.push(
			theme.fg(
				"muted",
				`Output · ${view.top + 1}–${view.top + view.lines.length}/${view.total} · ${state.top === undefined ? "live" : "paused"} · retained tail`,
			),
		);
		body = view.lines.map((line) => theme.fg("muted", line));
	} else if (pane === "details") {
		const lines = [
			theme.bold("Command"),
			...wrapped(selected.command, w),
			theme.bold("Directory"),
			...wrapped(selected.cwd, w),
			theme.fg(
				"dim",
				`Process ${selected.id} · ${selected.mode}${selected.pid ? ` · PID ${selected.pid}` : ""}`,
			),
		];
		body = lineWindow(lines, Math.max(0, rows - header.length - footer.length), state.top ?? 0).lines;
	} else {
		const listHeight = Math.min(runs.length, Math.max(1, Math.min(4, Math.floor((rows - 9) / 3))));
		const index = runs.indexOf(selected);
		const start = Math.max(0, index - listHeight + 1);
		body = runs.slice(start, start + listHeight).map((run) => {
			const prefix = run === selected ? "▸ " : "  ";
			return theme.fg(
				run === selected ? "accent" : "muted",
				truncateToWidth(
					`${prefix}${run.status} · ${duration(run)} · ${displayText(run.command).replace(/\s+/gu, " ")}`,
					w,
					"…",
				),
			);
		});
		const room = Math.max(0, rows - header.length - footer.length - body.length);
		const command = wrapped(`Command: ${selected.command}`, w);
		const directory = wrapped(`Directory: ${selected.cwd}`, w);
		const metadata = [
			...command.slice(0, Math.min(2, command.length)),
			...directory.slice(0, Math.min(2, directory.length)),
		];
		body.push(...metadata.slice(0, room));
		if (command.length > 2 || directory.length > 2)
			body.push(theme.fg("dim", "Tab → details for full command/directory"));
		const available = Math.max(0, rows - header.length - footer.length - body.length - 1);
		if (available > 0)
			body.push(
				theme.fg("dim", "Recent output · Tab → scroll logs"),
				...logLines(selected, w)
					.slice(-available)
					.map((line) => theme.fg("muted", line)),
			);
	}
	return sectionPanel(header, body, footer, width, rows);
}

export async function showProcesses(
	ctx: ExtensionCommandContext,
	getRuns: () => readonly BackgroundProcessRun[],
	initialId?: string,
	onStop?: (run: BackgroundProcessRun) => boolean,
): Promise<void> {
	let timer: ReturnType<typeof setInterval> | undefined;
	try {
		await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
			let selectedId = initialId ?? getRuns()[0]?.id;
			let pane: Pane = "overview";
			let top: number | undefined;
			let confirmingId: string | undefined;
			let notice: string | undefined;
			timer = setInterval(() => tui.requestRender(), 1000);
			return {
				render(width) {
					return renderProcessView(getRuns(), selectedId, width, tui.terminal.rows, theme, {
						pane,
						top,
						confirming: confirmingId !== undefined,
						notice,
					});
				},
				invalidate() {},
				handleInput(input) {
					const runs = getRuns();
					const selected = runs.find((run) => run.id === selectedId) ?? runs[0];
					if (confirmingId) {
						if (matchesKey(input, Key.escape)) confirmingId = undefined;
						else if (matchesKey(input, Key.enter)) {
							const target = runs.find((run) => run.id === confirmingId);
							notice = target && onStop?.(target) ? "Stopping process…" : "Process is no longer running.";
							confirmingId = undefined;
						}
						tui.requestRender();
						return;
					}
					if (matchesKey(input, Key.escape)) return done();
					notice = undefined;
					if ((input === "s" || input === "S") && selected) {
						if (selected.status === "running" && onStop) confirmingId = selected.id;
						else notice = "Process is not running.";
					} else if (matchesKey(input, Key.tab) || matchesKey(input, Key.shift("tab"))) {
						const panes: Pane[] = ["overview", "logs", "details"];
						pane = panes[(panes.indexOf(pane) + (matchesKey(input, Key.tab) ? 1 : 2)) % panes.length];
						top = undefined;
					} else if (pane !== "overview" && selected) {
						const height = Math.max(1, tui.terminal.rows - 5);
						const total =
							pane === "logs"
								? logLines(selected, tui.terminal.columns).length
								: wrapped(`${selected.command}\n${selected.cwd}\nmetadata`, tui.terminal.columns).length + 2;
						const end = Math.max(0, total - height);
						const current = top ?? (pane === "logs" ? end : 0);
						if (matchesKey(input, Key.home)) top = 0;
						else if (matchesKey(input, Key.end)) top = pane === "logs" ? undefined : end;
						else if (matchesKey(input, Key.up)) top = Math.max(0, current - 1);
						else if (matchesKey(input, Key.down)) top = Math.min(end, current + 1);
						else if (matchesKey(input, Key.pageUp)) top = Math.max(0, current - height);
						else if (matchesKey(input, Key.pageDown)) top = Math.min(end, current + height);
					} else {
						const index = Math.max(
							0,
							runs.findIndex((run) => run.id === selectedId),
						);
						let next = index;
						if (matchesKey(input, Key.up)) next--;
						else if (matchesKey(input, Key.down)) next++;
						else if (matchesKey(input, Key.home)) next = 0;
						else if (matchesKey(input, Key.end)) next = runs.length - 1;
						else if (matchesKey(input, Key.pageUp)) next -= 5;
						else if (matchesKey(input, Key.pageDown)) next += 5;
						selectedId = runs[Math.max(0, Math.min(runs.length - 1, next))]?.id;
					}
					tui.requestRender();
				},
			};
		});
	} finally {
		if (timer) clearInterval(timer);
	}
}
