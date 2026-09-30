import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { type Component, type TUI, visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { askSingleChoice } from "../extensions/ask-user-question/choices.js";
import type { BackgroundProcessRun } from "../extensions/background-process/index.js";
import { renderProcessView, showProcesses } from "../extensions/background-process/ui.js";
import { AccountPanel } from "../extensions/codex-accounts/panel.js";
import { showContextInspector } from "../extensions/context-inspector/ui.js";
import draftToggle from "../extensions/draft-toggle/index.js";
import { DRAFT_ENTRY_TYPE } from "../extensions/draft-toggle/state.js";
import { ClipboardImageDraft } from "../extensions/image-clipboard/state.js";
import { showImages } from "../extensions/image-clipboard/ui.js";
import { showSkillManager } from "../extensions/skill-manager/ui.js";
import { lineWindow, sectionPanel } from "../extensions/ui/sections.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};
function harness(rows = 14, columns = 50) {
	let component: (Component & { focused?: boolean; dispose?(): void }) | undefined;
	const terminal = { rows, columns };
	const tui = { terminal, requestRender: vi.fn() } as unknown as TUI;
	const ctx = {
		mode: "tui",
		ui: {
			custom: (
				factory: (tui: TUI, theme: unknown, keys: unknown, done: (value: unknown) => void) => Component,
			) =>
				new Promise((resolve) => {
					component = factory(tui, theme, {}, (value) => {
						component?.dispose?.();
						resolve(value);
					});
					component.focused = true;
				}),
		},
	} as unknown as ExtensionCommandContext;
	return {
		ctx,
		terminal,
		panel: () => {
			if (!component) throw new Error("Panel not opened");
			return component;
		},
	};
}
function run(): BackgroundProcessRun {
	return {
		id: "aaaabbbb",
		command: "printf hello",
		cwd: "/tmp",
		status: "running",
		mode: "wait",
		delivery: "none",
		startedAt: Date.now(),
		logBytes: 0,
		generation: 1,
	};
}
function bounded(component: Component, width: number, rows: number) {
	const lines = component.render(width);
	expect(lines.length).toBeLessThanOrEqual(rows);
	expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
	return lines.join("\n");
}

describe("task-specific viewports", () => {
	it("reserves task header and controls and keeps a selected content row", () => {
		const view = lineWindow(["zero", "one", "two", "selected"], 2, 0, 3);
		expect(view.lines).toEqual(["two", "selected"]);
		expect(sectionPanel(["Question"], view.lines, ["Esc cancel"], 10, 4)).toHaveLength(4);
	});
	it.each([2, 5, 10, 24])("bounds processes at %i rows and preserves useful logs", (rows) => {
		const process = { ...run(), output: Array.from({ length: 100 }, (_, i) => `line ${i}`).join("\n") };
		for (const pane of ["overview", "logs", "details"] as const) {
			const lines = renderProcessView([process], process.id, 20, rows, theme, { pane });
			expect(lines.length).toBeLessThanOrEqual(rows);
			expect(lines.every((line) => visibleWidth(line) <= 20)).toBe(true);
		}
		expect(renderProcessView([process], process.id, 60, 12, theme, { pane: "logs" }).join("\n")).toContain(
			"line 99",
		);
	});
	it("stops only after in-panel confirmation and lets logs scroll independently", async () => {
		const h = harness();
		const process = { ...run(), output: Array.from({ length: 40 }, (_, i) => `line ${i}`).join("\n") };
		const stop = vi.fn(() => true);
		const pending = showProcesses(h.ctx, () => [process], undefined, stop);
		const panel = h.panel();
		panel.handleInput?.("s");
		panel.handleInput?.("\x1b");
		expect(stop).not.toHaveBeenCalled();
		panel.handleInput?.("\t");
		panel.handleInput?.("\x1b[H");
		expect(bounded(panel, 50, 14)).toContain("line 0");
		expect(panel.render(50).join("\n")).toContain("paused");
		panel.handleInput?.("\x1b[F");
		expect(panel.render(50).join("\n")).toContain("live");
		panel.handleInput?.("s");
		panel.handleInput?.("\r");
		expect(stop).toHaveBeenCalledWith(process);
		panel.handleInput?.("\x1b");
		await pending;
	});
	it("keeps full commands/directories accessible rather than losing them to ellipses", () => {
		const process = {
			...run(),
			command: `echo ${"argument ".repeat(20)}END_COMMAND`,
			cwd: `/${"nested/".repeat(25)}END_DIRECTORY`,
		};
		const all = renderProcessView([process], process.id, 30, 80, theme, { pane: "details" }).join("\n");
		expect(all).toContain("END_COMMAND");
		expect(all.replaceAll("\n", "")).toContain("END_DIRECTORY");
	});
});

describe("human context and recovery", () => {
	it("reads long question/context and preserves unfinished Other text when going back", async () => {
		const h = harness(10, 40);
		const pending = askSingleChoice(h.ctx, `Question ${"long ".repeat(40)}`, "Context end", [
			{ label: "Alpha", value: "a", description: "Complete explanation" },
		]);
		const panel = h.panel();
		bounded(panel, 40, 10);
		panel.handleInput?.("\t");
		panel.handleInput?.("\x1b[F");
		expect(bounded(panel, 40, 10)).toContain("Complete explanation");
		panel.handleInput?.("\x1b");
		panel.handleInput?.("\x1b[F");
		panel.handleInput?.("\r");
		for (const char of "unfinished answer") panel.handleInput?.(char);
		panel.handleInput?.("\x1b");
		panel.handleInput?.("\r");
		expect(bounded(panel, 40, 10)).toContain("unfinished answer");
		panel.handleInput?.("\r");
		await expect(pending).resolves.toMatchObject({ type: "other", value: "unfinished answer" });
	});
	it("reports skill persistence failures without optimistic changes and supports retry", async () => {
		const h = harness(16, 65);
		const save = vi
			.fn()
			.mockRejectedValueOnce(new Error("secret storage path"))
			.mockResolvedValueOnce(undefined);
		const pending = showSkillManager(
			h.ctx,
			[{ name: "alpha", description: "First", defaultMode: "full" }],
			save,
		);
		const panel = h.panel();
		panel.handleInput?.("\x1b[C");
		await new Promise((resolve) => setImmediate(resolve));
		expect(bounded(panel, 65, 16)).toContain("Save failed");
		expect(panel.render(65).join("\n")).toContain("inherited from default");
		expect(panel.render(65).join("\n")).not.toContain("secret storage path");
		panel.handleInput?.("\x1b[C");
		await new Promise((resolve) => setImmediate(resolve));
		expect(panel.render(65).join("\n")).toContain("Saved · alpha");
		expect(panel.render(65).join("\n")).toContain("set in project");
		panel.handleInput?.("\x1b");
		await pending;
	});
	it("groups account actions and keeps full details accessible without activating anything", () => {
		const done = vi.fn();
		let rows = 10;
		const panel = new AccountPanel(
			{ accounts: [{ key: "vault:a", label: "Work", source: "vault", active: true, isDefault: false }] },
			theme as never,
			done,
			() => {},
			() => rows,
		);
		expect(bounded(panel, 50, rows)).toContain("Usar conta");
		panel.handleInput("g");
		expect(panel.render(50).join("\n")).toContain("Gerenciar");
		panel.handleInput("v");
		expect(bounded(panel, 50, rows)).toContain("cofre local");
		panel.handleInput("\x1b[F");
		bounded(panel, 50, rows);
		expect(done).not.toHaveBeenCalled();
		rows = 6;
		bounded(panel, 20, rows);
		panel.handleInput("\x1b");
		expect(done).not.toHaveBeenCalled();
		panel.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith(undefined);
	});
	it("opens full context inventory details and returns to the same selection", async () => {
		const h = harness(10, 35);
		const pending = showContextInspector(h.ctx, "messages", {
			options: { cwd: "/tmp" },
			messages: [{ role: "user", content: `${"detail ".repeat(40)}END_DETAIL` }],
			contents: { summary: "", files: "", skills: "", tools: "", messages: "", system: "", payload: "" },
			skillModes: new Map(),
		});
		const panel = h.panel();
		panel.handleInput?.("\r");
		panel.handleInput?.("\x1b[F");
		expect(bounded(panel, 35, 10)).toContain("END_DETAIL");
		panel.handleInput?.("\x1b");
		expect(panel.render(35).join("\n")).toContain("What conversation");
		panel.handleInput?.("\x1b");
		await pending;
	});
	it("previews a parked draft without restoring it or writing new state", async () => {
		const h = harness(10, 40);
		const shortcuts = new Map<string, (ctx: ExtensionContext) => unknown>();
		const events = new Map<string, (event: unknown, ctx: ExtensionContext) => void>();
		const appendEntry = vi.fn();
		const setEditorText = vi.fn();
		draftToggle({
			registerShortcut: (key: string, options: { handler: (ctx: ExtensionContext) => unknown }) =>
				shortcuts.set(key, options.handler),
			on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => void) =>
				events.set(event, handler),
			appendEntry,
		} as unknown as ExtensionAPI);
		const ctx = {
			...h.ctx,
			sessionManager: {
				getBranch: () => [
					{ type: "custom", customType: DRAFT_ENTRY_TYPE, data: { version: 1, draft: "saved prompt" } },
				],
			},
			ui: { ...h.ctx.ui, getEditorText: () => "current prompt", setEditorText, setWidget: vi.fn() },
		} as unknown as ExtensionContext;
		events.get("session_start")?.({}, ctx);
		const pending = shortcuts.get("ctrl+alt+d")?.(ctx);
		expect(bounded(h.panel(), 40, 10)).toContain("saved prompt");
		h.panel().handleInput?.("\x1b");
		await pending;
		expect(appendEntry).not.toHaveBeenCalled();
		expect(setEditorText).not.toHaveBeenCalled();
	});
	it("shows all attachments and removes only a confirmed placeholder, never its file", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-image-panel-"));
		try {
			const draft = new ClipboardImageDraft();
			const paths = ["one.png", "two.png", "three.png"].map((name) => join(root, name));
			for (const path of paths) {
				await writeFile(path, "image");
				draft.capture(path);
			}
			let text = "Look [Image 01] [Image 02] [Image 03]";
			const h = harness(14, 60);
			const onChange = vi.fn();
			const ctx = {
				...h.ctx,
				ui: {
					...h.ctx.ui,
					getEditorText: () => text,
					setEditorText: (value: string) => {
						text = value;
					},
				},
			};
			const pending = showImages(ctx, draft, onChange);
			const panel = h.panel();
			expect(bounded(panel, 60, 14)).toContain("three.png");
			panel.handleInput?.("\x1b[B");
			panel.handleInput?.("d");
			panel.handleInput?.("\x1b");
			expect(draft.previews()).toHaveLength(3);
			panel.handleInput?.("d");
			panel.handleInput?.("\r");
			expect(draft.previews()).toHaveLength(2);
			expect(text).not.toContain("[Image 02]");
			expect(text).toContain("[Image 03]");
			expect(await readFile(paths[1], "utf8")).toBe("image");
			expect(onChange).toHaveBeenCalledOnce();
			panel.handleInput?.("\x1b");
			await pending;
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});
});
