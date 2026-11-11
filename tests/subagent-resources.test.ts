import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionContext, RpcExtensionUIRequest } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { inheritResourceArgs } from "../extensions/subagent/resources.js";
import { forwardChildDialog } from "../extensions/subagent/rpc-ui.js";

describe("child resource inheritance", () => {
	it("resolves CLI resources against the parent directory without copying task or credentials", () => {
		expect(
			inheritResourceArgs(
				[
					"-e",
					"./extra.ts",
					"--extension",
					"builtin:mcp",
					"--extension",
					"npm:fixture",
					"--skill",
					"~/skills/review",
					"--prompt-template",
					"./review.md",
					"--theme",
					"./theme.json",
					"--api-key",
					"secret",
					"--session",
					"parent.jsonl",
					"--append-system-prompt",
					"private task",
					"@private.txt",
					"parent task",
				],
				"/parent",
			),
		).toEqual([
			"--extension",
			"/parent/extra.ts",
			"--extension",
			"builtin:mcp",
			"--extension",
			"npm:fixture",
			"--skill",
			join(homedir(), "skills/review"),
			"--prompt-template",
			"/parent/review.md",
			"--theme",
			"/parent/theme.json",
		]);
	});

	it("forwards only recognized extension CLI flags", () => {
		expect(
			inheritResourceArgs(["--headroom-json", "--mode-name=fast", "--unrelated"], "/parent", (name) =>
				new Map<string, boolean | string>([
					["headroom-json", true],
					["mode-name", "fast"],
				]).get(name),
			),
		).toEqual(["--headroom-json", "--mode-name=fast"]);
	});

	it("introduces no trust or resource opt-outs and preserves explicit parent opt-outs", () => {
		expect(inheritResourceArgs([], "/parent")).toEqual([]);
		expect(
			inheritResourceArgs(
				[
					"--no-extensions",
					"--no-skills",
					"--no-prompt-templates",
					"--no-themes",
					"--no-context-files",
					"--no-mcp",
					"--offline",
					"--no-approve",
					"--exclude-tools",
					"write,mcp__private__*",
				],
				"/parent",
			),
		).toEqual([
			"--no-extensions",
			"--no-skills",
			"--no-prompt-templates",
			"--no-themes",
			"--no-context-files",
			"--no-mcp",
			"--offline",
			"--no-approve",
			"--exclude-tools",
			"write,mcp__private__*",
		]);
		expect(inheritResourceArgs(["--approve"], "/parent")).toEqual(["--approve"]);
	});
});

describe("RPC child extension dialogs", () => {
	const request = { type: "extension_ui_request", id: "dialog" } as const;
	const signal = new AbortController().signal;
	function context(hasUI = true) {
		return {
			hasUI,
			ui: {
				confirm: vi.fn().mockResolvedValue(false),
				select: vi.fn().mockResolvedValue("B"),
				input: vi.fn().mockResolvedValue("answer"),
				editor: vi.fn().mockResolvedValue("edited"),
			},
		} as unknown as ExtensionContext;
	}

	it("routes approval to the parent UI without auto-approving", async () => {
		const ctx = context();
		expect(
			await forwardChildDialog(
				{ ...request, method: "confirm", title: "Approve?", message: "Action", timeout: 5000 },
				ctx,
				"worker",
				signal,
			),
		).toEqual({ type: "extension_ui_response", id: "dialog", confirmed: false });
		expect(ctx.ui.confirm).toHaveBeenCalledWith("[worker] Approve?", "Action", { signal, timeout: 5000 });
	});

	it.each([
		[{ ...request, method: "select", title: "Choose", options: ["A", "B"] }, "B"],
		[{ ...request, method: "input", title: "Question" }, "answer"],
		[{ ...request, method: "editor", title: "Edit", prefill: "old" }, "edited"],
	] as const)("returns dialog values for %j", async (dialog, value) => {
		expect(await forwardChildDialog(dialog as RpcExtensionUIRequest, context(), "worker", signal)).toEqual({
			type: "extension_ui_response",
			id: "dialog",
			value,
		});
	});

	it("cancels when UI is unavailable, aborted, or dismissed, and ignores display-only events", async () => {
		const dialog = { ...request, method: "input", title: "Question" } as const;
		const cancelled = { type: "extension_ui_response", id: "dialog", cancelled: true };
		expect(await forwardChildDialog(dialog, context(false), "worker", signal)).toEqual(cancelled);
		expect(await forwardChildDialog(dialog, context(), "worker", AbortSignal.abort())).toEqual(cancelled);
		const ctx = context();
		vi.mocked(ctx.ui.input).mockResolvedValue(undefined);
		expect(await forwardChildDialog(dialog, ctx, "worker", signal)).toEqual(cancelled);
		expect(
			await forwardChildDialog({ ...request, method: "notify", message: "hello" }, ctx, "worker", signal),
		).toBeUndefined();
	});
});
