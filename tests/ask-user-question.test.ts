import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { Check } from "typebox/value";
import { describe, expect, it } from "vitest";
import {
	type AskUserQuestionInput,
	AskUserQuestionParams,
	type AskUserQuestionResultDetails,
	answeredResult,
	MAX_FREEFORM_BYTES,
	MAX_OPTIONS,
	MAX_RESULT_BYTES,
	prepareQuestion,
} from "../extensions/ask-user-question/core.js";
import askUserQuestion from "../extensions/ask-user-question/index.js";

type AskTool = ToolDefinition<typeof AskUserQuestionParams, AskUserQuestionResultDetails>;

function registeredTool(): AskTool {
	let registered: AskTool | undefined;
	askUserQuestion({
		registerTool(tool: ToolDefinition) {
			registered = tool as AskTool;
		},
	} as unknown as ExtensionAPI);
	if (!registered) throw new Error("ask_user_question was not registered");
	return registered;
}

interface TestComponent {
	render(width: number): string[];
	handleInput?(data: string): void;
}

function customInteraction(interact: (component: TestComponent) => void): unknown {
	type Factory = (
		tui: unknown,
		theme: unknown,
		keybindings: unknown,
		done: (result: unknown) => void,
	) => TestComponent | Promise<TestComponent>;
	return (factory: Factory) =>
		new Promise((resolve, reject) => {
			const tui = { requestRender() {} };
			const theme = {
				fg: (_color: string, text: string) => text,
				bold: (text: string) => text,
			};
			void Promise.resolve(factory(tui, theme, {}, resolve))
				.then(interact)
				.catch(reject);
		});
}

function context(options: {
	mode?: "tui" | "rpc" | "json" | "print";
	hasUI?: boolean;
	editor?: (title: string) => Promise<string | undefined>;
	custom?: unknown;
}): ExtensionContext {
	return {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		ui: {
			editor: options.editor ?? (async () => undefined),
			custom: options.custom,
		},
	} as unknown as ExtensionContext;
}

async function execute(
	tool: AskTool,
	input: AskUserQuestionInput,
	ctx: ExtensionContext,
	signal?: AbortSignal,
) {
	return tool.execute("call", input, signal, undefined, ctx);
}

describe("ask_user_question core", () => {
	it("keeps the always-active schema bounded", () => {
		expect(Check(AskUserQuestionParams, { question: "Proceed?" })).toBe(true);
		expect(Check(AskUserQuestionParams, { question: "" })).toBe(false);
		expect(Check(AskUserQuestionParams, { question: "q".repeat(1_025) })).toBe(false);
		expect(Check(AskUserQuestionParams, { question: "Pick", details: "d".repeat(2_049) })).toBe(false);
		expect(Check(AskUserQuestionParams, { question: "Pick", options: [{ label: "x".repeat(257) }] })).toBe(
			false,
		);
		expect(
			Check(AskUserQuestionParams, {
				question: "Pick",
				options: Array.from({ length: MAX_OPTIONS + 1 }, () => ({ label: "x" })),
			}),
		).toBe(false);
	});

	it("discriminates text, single-select, and multi-select inputs", () => {
		expect(prepareQuestion({ question: " Explain " }).mode).toBe("text");
		expect(prepareQuestion({ question: "Pick", options: [{ label: " A ", value: " a " }] })).toMatchObject({
			mode: "single-select",
			options: [{ label: "A", value: "a" }],
		});
		expect(prepareQuestion({ question: "Pick", options: [{ label: "A" }], multiSelect: true }).mode).toBe(
			"multi-select",
		);
	});

	it("sorts multi-select answers and bounds UTF-8 model output", () => {
		const prepared = prepareQuestion({ question: "Pick", options: [{ label: "A" }], multiSelect: true });
		const result = answeredResult(prepared, [
			{ type: "other", label: "😀".repeat(5_000), value: "ignored" },
			{ type: "option", label: "Second", value: "second", index: 2 },
			{ type: "option", label: "First", value: "first", index: 1 },
		]);
		const output = result.content[0].text;
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(MAX_RESULT_BYTES);
		expect(output).toContain("[truncated:");
		expect(output).not.toContain("�");
		expect(result.details.answers.map((answer) => answer.type)).toEqual(["option", "option", "other"]);
		expect(Buffer.byteLength(result.details.answers[2].label)).toBeLessThanOrEqual(MAX_FREEFORM_BYTES);
	});
});

describe("ask_user_question extension", () => {
	it("returns a definitive unavailable result without UI", async () => {
		const result = await execute(
			registeredTool(),
			{ question: "Pick", options: [{ label: "A" }] },
			context({ mode: "json", hasUI: false }),
		);
		expect(result.content[0]).toEqual({ type: "text", text: "ask_user_question requires an interactive UI" });
		expect(result.details).toMatchObject({ status: "unavailable", mode: "single-select", answers: [] });
	});

	it("supports free text over RPC but rejects TUI-only choice dialogs", async () => {
		const tool = registeredTool();
		const textResult = await execute(
			tool,
			{ question: "Why?", details: "Be concise" },
			context({
				mode: "rpc",
				editor: async (title) => (title.includes("Be concise") ? "  because  " : undefined),
			}),
		);
		const textContent = textResult.content[0];
		if (textContent.type !== "text") throw new Error("expected text content");
		expect(textContent.text).toBe("User answered: because");
		expect(textResult.details).toMatchObject({ status: "answered", mode: "text" });

		const choiceResult = await execute(
			tool,
			{ question: "Pick", options: [{ label: "A" }] },
			context({ mode: "rpc" }),
		);
		expect(choiceResult.details).toMatchObject({ status: "unavailable", mode: "single-select" });
		const choiceContent = choiceResult.content[0];
		if (choiceContent.type !== "text") throw new Error("expected text content");
		expect(choiceContent.text).toBe("Choice questions require Pi's interactive TUI");
	});

	it("runs single-select and keeps resize renders within width", async () => {
		const result = await execute(
			registeredTool(),
			{ question: "Pick", options: [{ label: "Alpha", value: "a" }, { label: "Beta" }] },
			context({
				custom: customInteraction((component) => {
					expect(component.render(80).length).toBeGreaterThan(0);
					expect(component.render(9).every((line) => visibleWidth(line) <= 9)).toBe(true);
					component.handleInput?.("\r");
				}),
			}),
		);
		expect(result.content[0]).toEqual({ type: "text", text: "User selected: 1. Alpha" });
		expect(result.details).toMatchObject({
			status: "answered",
			mode: "single-select",
			answers: [{ type: "option", value: "a", index: 1 }],
		});
	});

	it("collects and submits multiple choices", async () => {
		const result = await execute(
			registeredTool(),
			{ question: "Pick", options: [{ label: "Alpha" }, { label: "Beta" }], multiSelect: true },
			context({
				custom: customInteraction((component) => {
					for (const key of [" ", "\u001b[B", " ", "\u001b[B", "\u001b[B", "\r"]) {
						component.handleInput?.(key);
					}
				}),
			}),
		);
		expect(result.content[0]).toEqual({
			type: "text",
			text: "User selected 2:\n- 1. Alpha\n- 2. Beta",
		});
		expect(result.details).toMatchObject({ status: "answered", mode: "multi-select" });
	});

	it("cancels before opening UI when already aborted", async () => {
		const controller = new AbortController();
		controller.abort();
		let opened = false;
		const result = await execute(
			registeredTool(),
			{ question: "Why?" },
			context({
				editor: async () => {
					opened = true;
					return "answer";
				},
			}),
			controller.signal,
		);
		expect(opened).toBe(false);
		expect(result.details).toMatchObject({ status: "cancelled", answers: [] });
	});

	it("serializes concurrent popup calls through the shared UI lock", async () => {
		const tool = registeredTool();
		const opened: string[] = [];
		const releases: Array<(answer: string) => void> = [];
		const ctx = context({
			editor: async (title) => {
				opened.push(title);
				return new Promise<string>((resolve) => releases.push(resolve));
			},
		});

		const first = execute(tool, { question: "First?" }, ctx);
		const second = execute(tool, { question: "Second?" }, ctx);
		await new Promise((resolve) => setImmediate(resolve));
		expect(opened).toEqual(["First?"]);

		releases[0]("one");
		await first;
		await new Promise((resolve) => setImmediate(resolve));
		expect(opened).toEqual(["First?", "Second?"]);
		releases[1]("two");
		await expect(second).resolves.toMatchObject({ details: { status: "answered" } });
	});
});
