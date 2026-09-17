import type { BuildSystemPromptOptions, ContextUsage } from "@earendil-works/pi-coding-agent";

export const CONTEXT_VIEWS = [
	"summary",
	"system",
	"messages",
	"payload",
	"files",
	"skills",
	"tools",
] as const;
export type ContextView = (typeof CONTEXT_VIEWS)[number];

export interface ContextSnapshot {
	usage: ContextUsage | undefined;
	systemPrompt: string;
	options: BuildSystemPromptOptions;
	messages: unknown[];
	payload: unknown;
	payloadCapturedAt: string | undefined;
	sessionId: string;
	sessionFile: string | undefined;
	model: string | undefined;
}

export function parseContextView(value: string): ContextView | undefined {
	const normalized = value.trim().toLowerCase() || "summary";
	return CONTEXT_VIEWS.find((view) => view === normalized);
}

function bytes(value: string): string {
	return `${Buffer.byteLength(value, "utf8").toLocaleString()} B`;
}

function json(value: unknown): string {
	return JSON.stringify(value, null, 2) ?? "undefined";
}

function listOrNone(values: readonly string[]): string {
	return values.length > 0 ? values.join("\n") : "(none)";
}

export function renderContextView(view: ContextView, snapshot: ContextSnapshot): string {
	const { options } = snapshot;
	if (view === "system") return snapshot.systemPrompt;
	if (view === "messages") return json(snapshot.messages);
	if (view === "payload") {
		return snapshot.payload === undefined
			? "No provider request captured yet. Send one model turn, then run /context payload."
			: json(snapshot.payload);
	}
	if (view === "files") {
		return listOrNone(
			(options.contextFiles ?? []).map((file) => `${file.path}\n  ${bytes(file.content)}\n${file.content}`),
		);
	}
	if (view === "skills") {
		return listOrNone(
			(options.skills ?? []).map(
				(skill) =>
					`${skill.name}\n  file: ${skill.filePath}\n  model-visible: ${!skill.disableModelInvocation}\n  ${skill.description}`,
			),
		);
	}
	if (view === "tools") {
		return json({ selected: options.selectedTools ?? [], snippets: options.toolSnippets ?? {} });
	}

	const usage = snapshot.usage;
	const files = options.contextFiles ?? [];
	const skills = options.skills ?? [];
	const messageBytes = bytes(json(snapshot.messages));
	return [
		"Context inspector",
		`session: ${snapshot.sessionId}`,
		`session file: ${snapshot.sessionFile ?? "(ephemeral)"}`,
		`model: ${snapshot.model ?? "(none)"}`,
		`usage: ${usage?.tokens?.toLocaleString() ?? "unknown"} / ${usage?.contextWindow.toLocaleString() ?? "unknown"} tokens (${usage?.percent?.toFixed(1) ?? "unknown"}%)`,
		`system prompt: ${bytes(snapshot.systemPrompt)}`,
		`conversation: ${snapshot.messages.length} messages, ${messageBytes}`,
		`context files: ${files.length}`,
		`skills loaded: ${skills.length} (${skills.filter((skill) => !skill.disableModelInvocation).length} model-visible)`,
		`tools selected: ${options.selectedTools?.length ?? 0}`,
		`last provider payload: ${snapshot.payloadCapturedAt ?? "not captured"}`,
		"",
		"Views: /context summary|system|messages|payload|files|skills|tools",
		"Exactness: payload is the last serialized provider body observed by this extension. System/options are current base inputs; messages are the last model-call context observed by this extension.",
		"Blind spots: extensions loaded after this one may still rewrite payload; secrets in HTTP headers are never captured; current token usage can be estimated by Pi.",
	].join("\n");
}
