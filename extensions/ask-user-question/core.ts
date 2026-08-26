import { type Static, Type } from "typebox";

const MAX_QUESTION_CHARS = 1_024;
const MAX_DETAILS_CHARS = 2_048;
export const MAX_OPTIONS = 12;
const MAX_OPTION_LABEL_CHARS = 256;
const MAX_OPTION_VALUE_CHARS = 256;
const MAX_OPTION_DESCRIPTION_CHARS = 512;
export const MAX_FREEFORM_BYTES = 6 * 1_024;
export const MAX_RESULT_BYTES = 8 * 1_024;

const OptionSchema = Type.Object(
	{
		label: Type.String({
			minLength: 1,
			maxLength: MAX_OPTION_LABEL_CHARS,
			description: 'Option label. Put a recommended option first and suffix its label with "(Recommended)".',
		}),
		value: Type.Optional(
			Type.String({
				maxLength: MAX_OPTION_VALUE_CHARS,
				description: "Value returned for this option; defaults to its label",
			}),
		),
		description: Type.Optional(
			Type.String({
				maxLength: MAX_OPTION_DESCRIPTION_CHARS,
				description: "Short supporting detail shown below the label",
			}),
		),
	},
	{ additionalProperties: false },
);

export const AskUserQuestionParams = Type.Object(
	{
		question: Type.String({
			minLength: 1,
			maxLength: MAX_QUESTION_CHARS,
			description: "One question to ask the user",
		}),
		details: Type.Optional(
			Type.String({
				maxLength: MAX_DETAILS_CHARS,
				description: "Optional context shown below the question",
			}),
		),
		options: Type.Optional(
			Type.Array(OptionSchema, {
				maxItems: MAX_OPTIONS,
				description: "Choices; omit for free-form text. A custom Other choice is added automatically.",
			}),
		),
		multiSelect: Type.Optional(
			Type.Boolean({ description: "Allow multiple choices from this one question" }),
		),
	},
	{ additionalProperties: false },
);

export type AskUserQuestionInput = Static<typeof AskUserQuestionParams>;

export interface AskOption {
	label: string;
	value: string;
	description?: string;
}

export interface TextAnswer {
	type: "text";
	label: string;
	value: string;
}

export interface OptionAnswer {
	type: "option";
	label: string;
	value: string;
	index: number;
}

export interface OtherAnswer {
	type: "other";
	label: string;
	value: string;
}

export type AskAnswer = TextAnswer | OptionAnswer | OtherAnswer;
export type AskUserQuestionStatus = "answered" | "cancelled" | "unavailable";
export type AskUserQuestionMode = "text" | "single-select" | "multi-select";

export interface AskUserQuestionResultDetails {
	status: AskUserQuestionStatus;
	question: string;
	context?: string;
	mode: AskUserQuestionMode;
	answers: AskAnswer[];
	message?: string;
}

export interface PreparedQuestion {
	question: string;
	context?: string;
	options: AskOption[];
	mode: AskUserQuestionMode;
}

export interface AskUserQuestionResult {
	content: Array<{ type: "text"; text: string }>;
	details: AskUserQuestionResultDetails;
}

export function normalizeOptions(options: AskUserQuestionInput["options"]): AskOption[] {
	return (options ?? [])
		.map((option) => {
			const label = option.label.trim();
			return {
				label,
				value: option.value?.trim() || label,
				description: option.description?.trim() || undefined,
			};
		})
		.filter((option) => option.label.length > 0);
}

export function prepareQuestion(input: AskUserQuestionInput): PreparedQuestion {
	const question = input.question.trim();
	if (!question) throw new Error("ask_user_question question cannot be empty");
	const options = normalizeOptions(input.options);
	return {
		question,
		context: input.details?.trim() || undefined,
		options,
		mode: options.length === 0 ? "text" : input.multiSelect ? "multi-select" : "single-select",
	};
}

export function getOtherLabel(options: AskOption[]): string {
	return options.some((option) => option.label.toLowerCase() === "other") ? "Other (custom)" : "Other";
}

function utf8Prefix(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	let end = Math.min(bytes.length, maxBytes);
	const decoder = new TextDecoder("utf-8", { fatal: true });
	while (end > 0) {
		try {
			return decoder.decode(bytes.subarray(0, end));
		} catch {
			end--;
		}
	}
	return "";
}

function boundText(text: string, maxBytes: number): { text: string; truncated: boolean } {
	const totalBytes = Buffer.byteLength(text);
	if (totalBytes <= maxBytes) return { text, truncated: false };
	const marker = `\n[truncated: ${totalBytes} bytes total]`;
	return {
		text: `${utf8Prefix(text, Math.max(0, maxBytes - Buffer.byteLength(marker)))}${marker}`,
		truncated: true,
	};
}

function boundAnswer(answer: AskAnswer): AskAnswer {
	if (answer.type === "option") return answer;
	const value = boundText(answer.label.trim(), MAX_FREEFORM_BYTES).text;
	return { ...answer, label: value, value };
}

function answerSortRank(answer: AskAnswer): number {
	if (answer.type === "option") return answer.index;
	return answer.type === "other" ? Number.MAX_SAFE_INTEGER - 1 : Number.MAX_SAFE_INTEGER;
}

export function sortAnswers(answers: AskAnswer[]): AskAnswer[] {
	return [...answers].sort((left, right) => answerSortRank(left) - answerSortRank(right));
}

function formatAnswer(answer: AskAnswer): string {
	if (answer.type === "option") return `${answer.index}. ${answer.label}`;
	if (answer.type === "other") return `Other: ${answer.label}`;
	return answer.label;
}

function result(
	status: AskUserQuestionStatus,
	prepared: Pick<PreparedQuestion, "question" | "context" | "mode">,
	answers: AskAnswer[],
	text: string,
	message?: string,
): AskUserQuestionResult {
	return {
		content: [{ type: "text", text: boundText(text, MAX_RESULT_BYTES).text }],
		details: {
			status,
			question: prepared.question,
			context: prepared.context,
			mode: prepared.mode,
			answers,
			message,
		},
	};
}

export function answeredResult(
	prepared: Pick<PreparedQuestion, "question" | "context" | "mode">,
	inputAnswers: AskAnswer[],
): AskUserQuestionResult {
	const answers = sortAnswers(inputAnswers.map(boundAnswer));
	let text: string;
	if (prepared.mode === "text") {
		const answer = answers[0];
		text = answer?.label ? `User answered: ${answer.label}` : "User submitted an empty response";
	} else if (prepared.mode === "single-select") {
		text = answers[0] ? `User selected: ${formatAnswer(answers[0])}` : "User selected 0 answers";
	} else {
		text = answers.length
			? `User selected ${answers.length}:\n${answers.map((answer) => `- ${formatAnswer(answer)}`).join("\n")}`
			: "User selected 0 answers";
	}
	return result("answered", prepared, answers, text);
}

export function cancelledResult(
	prepared: Pick<PreparedQuestion, "question" | "context" | "mode">,
): AskUserQuestionResult {
	const message = "Question cancelled by user";
	return result("cancelled", prepared, [], message, message);
}

export function unavailableResult(
	prepared: Pick<PreparedQuestion, "question" | "context" | "mode">,
	message: string,
): AskUserQuestionResult {
	return result("unavailable", prepared, [], message, message);
}
