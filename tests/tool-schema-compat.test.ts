import { type ToolCall, validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { AskUserQuestionParams, MAX_OPTIONS } from "../extensions/ask-user-question/core.js";

const tool = {
	name: "ask_user_question",
	description: "Ask one question",
	parameters: AskUserQuestionParams,
};

function validate(args: ToolCall["arguments"]) {
	return validateToolArguments(tool, {
		type: "toolCall",
		id: "schema-compat",
		name: tool.name,
		arguments: args,
	});
}

describe("Pi tool argument validation compatibility", () => {
	it("coerces optional values using the real extension schema", () => {
		expect(
			validate({ question: "Choose?", details: null, multiSelect: "true", options: { label: "One" } }),
		).toEqual({ question: "Choose?", multiSelect: true, options: [{ label: "One" }] });
	});

	it.each<ToolCall["arguments"]>([
		{},
		{ question: "" },
		{ question: "x".repeat(1_025) },
		{ question: "Choose?", options: [{ label: "" }] },
		{ question: "Choose?", options: Array.from({ length: MAX_OPTIONS + 1 }, () => ({ label: "One" })) },
	])("rejects missing or out-of-bounds arguments: %j", (args) => {
		expect(() => validate(args)).toThrow();
	});
});
