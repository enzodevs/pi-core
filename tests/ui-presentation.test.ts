import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, CURSOR_MARKER, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { showSkillManager } from "../extensions/skill-manager/ui.js";
import interfaceDefaults from "../extensions/ui/index.js";
import { fitPanel, responsivePanel } from "../extensions/ui/presentation.js";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

describe("native interface defaults", () => {
	it("hides animation only in TUI and restores the harness default on cleanup", () => {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		interfaceDefaults({
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) => {
				handlers.set(event, handler);
			},
		} as unknown as ExtensionAPI);
		const setWorkingIndicator = vi.fn();
		const ctx = { mode: "tui", ui: { setWorkingIndicator } } as unknown as ExtensionContext;
		handlers.get("session_start")?.({}, ctx);
		expect(setWorkingIndicator).toHaveBeenCalledWith({ frames: [] });
		handlers.get("session_shutdown")?.({}, ctx);
		expect(setWorkingIndicator).toHaveBeenLastCalledWith();
		setWorkingIndicator.mockClear();
		handlers.get("session_start")?.({}, { ...ctx, mode: "rpc" });
		expect(setWorkingIndicator).not.toHaveBeenCalled();
	});
});

describe("shared TUI presentation", () => {
	it.each([0, 1, 5, 12, 40, 80])("bounds Unicode and ANSI at width %i", (width) => {
		const lines = fitPanel(["\x1b[31m界 👩‍💻 heading\x1b[0m", "› selected row", "Esc close"], width, 2);
		expect(lines.length).toBeLessThanOrEqual(2);
		expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	});
	it("retains selection, heading and help on short terminals", () => {
		const lines = fitPanel(
			["Title", ...Array.from({ length: 20 }, (_, i) => `${i === 16 ? "›" : " "} row ${i}`), "Esc close"],
			30,
			5,
		);
		expect(lines).toHaveLength(5);
		expect(lines[0]).toBe("Title");
		expect(lines.join("\n")).toContain("› row 16");
		expect(lines.at(-1)).toBe("Esc close");
	});
	it("prioritizes IME cursor over selection and removes decorative borders when cramped", () => {
		const lines = fitPanel(
			["────", "Question", "› option", "details", `answer${CURSOR_MARKER}`, "Enter submit", "────"],
			30,
			4,
		);
		expect(lines.join("\n")).toContain(CURSOR_MARKER);
		expect(lines[0]).toBe("Question");
		expect(lines.at(-1)).toBe("Enter submit");
	});
	it("forwards focus, input, invalidation and disposal and responds to resize", () => {
		const source = {
			focused: false,
			render: () => ["Title", "one", "› two", "three", "Esc close"],
			handleInput: vi.fn(),
			invalidate: vi.fn(),
			dispose: vi.fn(),
		};
		const terminal = { rows: 4 };
		const tui = { terminal } as TUI;
		const panel = responsivePanel(source, tui);
		panel.focused = true;
		expect(source.focused).toBe(true);
		panel.handleInput?.("x");
		panel.invalidate();
		panel.dispose();
		expect(source.handleInput).toHaveBeenCalledWith("x");
		expect(source.invalidate).toHaveBeenCalledOnce();
		expect(source.dispose).toHaveBeenCalledOnce();
		expect(panel.render(20)).toHaveLength(4);
		terminal.rows = 2;
		expect(panel.render(20)).toHaveLength(2);
	});
});

describe("skill manager keyboard search", () => {
	it("filters with native Input and never changes a skill merely by searching", async () => {
		let panel: Component | undefined;
		const terminal = { rows: 24 };
		const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
		const onChange = vi.fn();
		const ctx = {
			ui: {
				custom: async (factory: (tui: TUI, theme: unknown, keys: unknown, done: () => void) => Component) => {
					panel = factory(tui, theme, {}, () => {});
				},
			},
		} as unknown as ExtensionCommandContext;
		await showSkillManager(
			ctx,
			[
				{ name: "alpha", description: "First", defaultMode: "full" },
				{ name: "beta", description: "Second", defaultMode: "name" },
			],
			onChange,
		);
		if (!panel) throw new Error("No panel");
		panel.handleInput?.("/");
		for (const char of "beta") panel.handleInput?.(char);
		expect(panel.render(60).join("\n")).toContain("beta");
		expect(panel.render(60).join("\n")).not.toContain("alpha");
		expect(onChange).not.toHaveBeenCalled();
		panel.handleInput?.("\r");
		panel.handleInput?.("\x1b[C");
		expect(onChange).toHaveBeenCalledWith("project", "beta", "full");
		terminal.rows = 5;
		expect(panel.render(12).length).toBeLessThanOrEqual(5);
	});
});
