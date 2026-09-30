import { stripVTControlCharacters } from "node:util";
import { describe, expect, it } from "vitest";
import type { BackgroundProcessRun } from "../extensions/background-process/index.js";
import { renderProcessView } from "../extensions/background-process/ui.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function process(id: string, status: BackgroundProcessRun["status"] = "running"): BackgroundProcessRun {
	return {
		id,
		command: "printf hello",
		cwd: "/tmp",
		mode: "wait",
		status,
		delivery: "none",
		startedAt: Date.now(),
		logBytes: 0,
		generation: 1,
	};
}

describe("/ps TUI", () => {
	it("shows a useful empty state without adding a model message", () => {
		const view = renderProcessView([], undefined, 80, 24, theme).join("\n");
		expect(view).toContain("0 running · 0 recent");
		expect(view).toContain("No processes in this session yet.");
	});

	it("shows the selected run and the latest live output without terminal control sequences", () => {
		const first = process("aaaabbbb");
		const selected = process("ccccdddd", "complete");
		selected.exitCode = 0;
		selected.log = { tail: () => "old\n\u001b[31mfinished\u001b[0m\u0007" } as NonNullable<
			typeof selected.log
		>;
		const view = renderProcessView([first, selected], selected.id, 48, 16, theme);
		expect(view.join("\n")).toContain("Command: printf hello");
		expect(
			renderProcessView([selected], selected.id, 48, 16, theme, { pane: "details" }).join("\n"),
		).toContain("Process ccccdddd");
		expect(view.join("\n")).toContain("finished");
		expect(view.join("\n")).not.toContain("[31m");
		expect(view.join("\n")).not.toContain("\u0007");
		expect(view.every((line) => stripVTControlCharacters(line).length <= 48)).toBe(true);
	});

	it("bounds output to terminal rows and shows the newest lines", () => {
		const run = process("aaaabbbb");
		run.log = { tail: () => Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n") } as NonNullable<
			typeof run.log
		>;
		const view = renderProcessView([run], run.id, 80, 20, theme);
		expect(view.length).toBeLessThanOrEqual(20);
		expect(view.join("\n")).toContain("line 29");
		expect(view.join("\n")).not.toContain("line 0\n");
	});
});
