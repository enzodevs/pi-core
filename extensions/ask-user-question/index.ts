import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { askMultiChoice, askSingleChoice } from "./choices.js";
import {
	type AskOption,
	AskUserQuestionParams,
	type AskUserQuestionResultDetails,
	answeredResult,
	cancelledResult,
	getOtherLabel,
	normalizeOptions,
	prepareQuestion,
	unavailableResult,
} from "./core.js";
import { withSharedUiLock } from "./ui-lock.js";

function renderOptions(value: unknown): AskOption[] {
	if (!Array.isArray(value)) return [];
	return normalizeOptions(
		value.filter(
			(option): option is { label: string; value?: string; description?: string } =>
				typeof option === "object" && option !== null && typeof option.label === "string",
		),
	);
}

export default function askUserQuestion(pi: ExtensionAPI): void {
	pi.registerTool({
		name: "ask_user_question",
		label: "Ask User Question",
		description:
			"Ask one clarifying, preference, or decision question and wait for the user. Supports free text, one choice, or multiple choices; every choice list includes Other.",
		parameters: AskUserQuestionParams,
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const prepared = prepareQuestion(params);
			if (signal?.aborted) return cancelledResult(prepared);
			if (!ctx.hasUI) return unavailableResult(prepared, "ask_user_question requires an interactive UI");
			if (prepared.mode !== "text" && ctx.mode !== "tui")
				return unavailableResult(prepared, "Choice questions require Pi's interactive TUI");
			return withSharedUiLock(async () => {
				if (signal?.aborted) return cancelledResult(prepared);
				if (prepared.mode === "text") {
					const title = prepared.context ? `${prepared.question}\n\n${prepared.context}` : prepared.question;
					const answer = await ctx.ui.editor(title);
					if (answer === undefined) return cancelledResult(prepared);
					return answeredResult(prepared, [{ type: "text", label: answer.trim(), value: answer.trim() }]);
				}
				if (prepared.mode === "single-select") {
					const answer = await askSingleChoice(ctx, prepared.question, prepared.context, prepared.options);
					return answer ? answeredResult(prepared, [answer]) : cancelledResult(prepared);
				}
				const answers = await askMultiChoice(ctx, prepared.question, prepared.context, prepared.options);
				return answers ? answeredResult(prepared, answers) : cancelledResult(prepared);
			});
		},
		renderCall(args, theme) {
			const options = renderOptions(args.options);
			let text = theme.fg("toolTitle", theme.bold("ask_user_question "));
			text += theme.fg("muted", typeof args.question === "string" ? args.question : "");
			if (args.multiSelect) text += theme.fg("dim", " [multi-select]");
			if (options.length)
				text += `\n${theme.fg("dim", `  Options: ${[...options.map((option) => option.label), getOtherLabel(options)].join(", ")}`)}`;
			return new Text(text, 0, 0);
		},
		renderResult(result, _options, theme) {
			const details = result.details as AskUserQuestionResultDetails | undefined;
			if (!details) {
				const first = result.content[0];
				return new Text(first?.type === "text" ? first.text : "", 0, 0);
			}
			if (details.status !== "answered")
				return new Text(theme.fg("warning", details.message ?? details.status), 0, 0);
			return new Text(
				details.answers
					.map((answer) => {
						if (answer.type === "option")
							return `${theme.fg("success", "✓ ")}${answer.index}. ${answer.label}`;
						if (answer.type === "other")
							return `${theme.fg("success", "✓ ")}${theme.fg("muted", "Other: ")}${answer.label}`;
						return `${theme.fg("success", "✓ ")}${answer.label || theme.fg("dim", "(empty response)")}`;
					})
					.join("\n"),
				0,
				0,
			);
		},
	});
}
