import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LocalTranslator, translationPrompt } from "../extensions/translate/backend.js";
import promptTranslation from "../extensions/translate/index.js";
import { restoreEnabled, TRANSLATE_ENTRY } from "../extensions/translate/state.js";
import { protectText, restoreText, splitText, translateText } from "../extensions/translate/text.js";

function harness() {
	const start = vi.spyOn(LocalTranslator.prototype, "start").mockResolvedValue();
	const stop = vi.spyOn(LocalTranslator.prototype, "stop").mockResolvedValue();
	const translate = vi.spyOn(LocalTranslator.prototype, "translate").mockResolvedValue("Fix the error.");
	const manager = SessionManager.inMemory("/tmp");
	let editor = "";
	const ctx = {
		mode: "tui",
		ui: {
			theme: { fg: (_color: string, text: string) => text },
			setStatus: vi.fn(),
			notify: vi.fn(),
			getEditorText: () => editor,
			setEditorText: vi.fn((text: string) => {
				editor = text;
			}),
		},
		sessionManager: manager,
	} as unknown as ExtensionContext;
	const pi = {
		on: vi.fn(),
		registerCommand: vi.fn(),
		appendEntry: vi.fn((type: string, data: unknown) => manager.appendCustomEntry(type, data)),
		registerTool: vi.fn(),
		sendMessage: vi.fn(),
		sendUserMessage: vi.fn(),
	};
	promptTranslation(pi as unknown as ExtensionAPI);
	const hook = (name: string) => {
		const handler = pi.on.mock.calls.find(([event]) => event === name)?.[1];
		if (!handler) throw new Error(`Missing ${name} handler`);
		return handler;
	};
	const command = (action: string) => pi.registerCommand.mock.calls[0]?.[1].handler(action, ctx);
	const input = (text = "Corrija o erro.", source = "interactive", images?: unknown[]) =>
		hook("input")({ text, source, images }, ctx);
	return { pi, ctx, manager, start, stop, translate, hook, command, input };
}

afterEach(() => vi.restoreAllMocks());

describe("translation text protection", () => {
	it("restores literal code, paths, identifiers, flags, strings, images and URLs byte-for-byte", async () => {
		const input =
			"Corrija `validateInput` em /home/dev/src/index.ts usando --dry-run e snake_case, camelCase. Consulte https://example.org/a.\n[Image 01]\n```ts\nconst mensagem = 'não traduzir';\n```\nNão altere \"Texto literal\".";
		const plan = protectText(input);
		expect(plan.masked).not.toContain("não traduzir");
		expect(plan.masked).not.toContain("validateInput");
		expect(restoreText(plan, plan.masked)).toBe(input);
		expect(
			await translateText(input, async (text) =>
				text.replace("Corrija", "Fix").replace("Não altere", "Do not change"),
			),
		).toBe(input.replace("Corrija", "Fix").replace("Não altere", "Do not change"));
	});

	it("protects unclosed and tilde code fences and multi-backtick inline code", () => {
		for (const text of ["Teste\n```ts\nconst x = 1;", "Teste\n~~~py\nx = 'a'\n~~~", "Teste ``a`b``."]) {
			const plan = protectText(text);
			expect(plan.literals).toHaveLength(1);
			expect(restoreText(plan, plan.masked)).toBe(text);
		}
	});

	it("rejects missing, duplicated, reordered and unknown protected markers", () => {
		const plan = protectText("Confira `first` e `second`.");
		for (const text of [
			"Confira.",
			"__PI_KEEP_0__ __PI_KEEP_0__",
			"__PI_KEEP_1__ __PI_KEEP_0__",
			"__PI_KEEP_0__ __PI_KEEP_9__",
		]) {
			expect(() => restoreText(plan, text)).toThrow("protected literal");
		}
	});

	it("bounds inputs and rejects reserved markers repeatedly without regex state leakage", () => {
		expect(() => protectText("a".repeat(32 * 1024 + 1))).toThrow("32 KiB");
		for (let i = 0; i < 3; i++) expect(() => protectText("__PI_KEEP_0__")).toThrow("reserved");
	});

	it("splits large prompts losslessly without cutting markers", async () => {
		const input = "Corrija o erro. ".repeat(300);
		expect(splitText(input).join("")).toBe(input);
		expect(await translateText(input, async (text) => text)).toBe(input);
		expect(() => splitText("a".repeat(1801))).toThrow("unbroken");
	});

	it("bounds translated output and handles long unmatched backtick runs", async () => {
		const backticks = "`".repeat(32 * 1024);
		expect(protectText(backticks).masked).toBe(backticks);
		await expect(translateText("Olá", async () => "a".repeat(32 * 1024 + 1))).rejects.toThrow(
			"exceeds 32 KiB",
		);
	});

	it("does not translate code-only prompts and rejects empty output", async () => {
		const translate = vi.fn(async () => "");
		expect(await translateText("```ts\nconst x = 1;\n```", translate)).toBe("```ts\nconst x = 1;\n```");
		expect(translate).not.toHaveBeenCalled();
		await expect(translateText("Corrija o erro", translate)).rejects.toThrow("empty");
	});

	it("uses the actual TranslateGemma pt-BR to English template only in the local backend", () => {
		expect(translationPrompt("  Olá  ")).toContain("Portuguese (pt-BR) to English (en)");
		expect(translationPrompt("Olá").endsWith("Olá<end_of_turn>\n<start_of_turn>model\n")).toBe(true);
	});
});

describe("session-only, model-invisible translation", () => {
	it("defaults off without spawning anything or registering model-facing surfaces", async () => {
		const h = harness();
		expect(await h.input()).toEqual({ action: "continue" });
		expect(h.start).not.toHaveBeenCalled();
		expect(h.translate).not.toHaveBeenCalled();
		expect(h.pi.registerTool).not.toHaveBeenCalled();
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
		expect(h.pi.sendUserMessage).not.toHaveBeenCalled();
		expect(h.pi.on.mock.calls.map(([name]) => name)).not.toContain("before_agent_start");
	});

	it("transforms only user text, preserving attached images and adding no messages", async () => {
		const h = harness();
		await h.command("on");
		const images = [{ type: "image", data: "test", mimeType: "image/png" }];
		expect(await h.input("Corrija o erro.", "interactive", images)).toEqual({
			action: "transform",
			text: "Fix the error.",
			images,
		});
		for (const [text, source] of [
			["Corrija o erro.", "extension"],
			["/skill:test", "interactive"],
			["!pwd", "interactive"],
		]) {
			expect(await h.input(text, source)).toEqual({ action: "continue" });
		}
		expect(h.translate).toHaveBeenCalledTimes(1);
		expect(buildSessionContext(h.manager.getEntries()).messages).toEqual([]);
		expect(h.pi.sendMessage).not.toHaveBeenCalled();
	});

	it("does not enable when startup fails and stops immediately on off", async () => {
		const h = harness();
		h.start.mockRejectedValueOnce(new Error("model missing"));
		await h.command("on");
		expect(await h.input()).toEqual({ action: "continue" });
		await h.command("on");
		await h.command("off");
		expect(h.stop).toHaveBeenCalledTimes(1);
		expect(await h.input()).toEqual({ action: "continue" });
	});

	it("restores this session on reload/resume but resets new sessions and forks", async () => {
		const h = harness();
		await h.command("on");
		await h.hook("session_shutdown")({ reason: "reload" }, h.ctx);
		await h.hook("session_start")({ reason: "reload" }, h.ctx);
		expect(await h.input()).toMatchObject({ action: "transform" });
		for (const reason of ["new", "fork"]) {
			await h.command("on");
			await h.hook("session_start")({ reason }, h.ctx);
			expect(await h.input()).toEqual({ action: "continue" });
			expect(restoreEnabled(h.manager.getBranch())).toBe(false);
		}
	});

	it("follows branch state and rejects malformed latest preferences", async () => {
		const h = harness();
		await h.command("on");
		h.manager.appendCustomEntry(TRANSLATE_ENTRY, { enabled: true, version: 99 });
		expect(restoreEnabled(h.manager.getBranch())).toBe(false);
		await h.hook("session_tree")({}, h.ctx);
		expect(await h.input()).toEqual({ action: "continue" });
		expect(h.stop).toHaveBeenCalled();
	});

	it("blocks failures, restores the original and retains native images for resubmission", async () => {
		const h = harness();
		await h.command("on");
		h.translate.mockRejectedValueOnce(new Error("timeout"));
		const images = [{ type: "image", data: "test", mimeType: "image/png" }];
		expect(await h.input("Corrija o erro.", "interactive", images)).toEqual({ action: "handled" });
		expect(h.ctx.ui.setEditorText).toHaveBeenCalledWith("Corrija o erro.");
		await h.command("off");
		expect(await h.input()).toEqual({ action: "transform", text: "Corrija o erro.", images });
	});

	it("does not overwrite a newer draft and supports explicit local recovery", async () => {
		const h = harness();
		await h.command("on");
		h.ctx.ui.setEditorText("Another draft");
		h.translate.mockRejectedValueOnce(new Error("failed"));
		await h.input();
		expect(h.ctx.ui.getEditorText()).toBe("Another draft");
		await h.command("recover");
		expect(h.ctx.ui.getEditorText()).toBe("Another draft");
		h.ctx.ui.setEditorText("");
		await h.command("recover");
		expect(h.ctx.ui.getEditorText()).toBe("Corrija o erro.");
	});

	it("recovers rather than silently dropping a prompt when disabled during inference", async () => {
		const h = harness();
		await h.command("on");
		let complete: ((text: string) => void) | undefined;
		h.translate.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const pending = h.input();
		await h.command("off");
		complete?.("Fix the error.");
		expect(await pending).toEqual({ action: "handled" });
		expect(h.ctx.ui.getEditorText()).toBe("Corrija o erro.");
	});

	it("does not deliver an in-flight prompt into a replaced session", async () => {
		const h = harness();
		await h.command("on");
		let complete: ((text: string) => void) | undefined;
		h.translate.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const pending = h.input();
		await h.hook("session_shutdown")({ reason: "new" }, h.ctx);
		complete?.("Fix the error.");
		expect(await pending).toEqual({ action: "handled" });
		expect(h.ctx.ui.setEditorText).not.toHaveBeenCalled();
	});
});
