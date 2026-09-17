import { homedir } from "node:os";
import { dirname, relative, resolve, sep } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	type BuildSystemPromptOptions,
	type ContextUsage,
	estimateTokens,
} from "@earendil-works/pi-coding-agent";

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
	toolDefinitions: unknown[];
}

export interface ContextEstimate {
	promptTokens: number;
	messageTokens: number;
	toolTokens: number;
	totalTokens: number;
	percent: number | undefined;
}

function estimateValueTokens(value: unknown): number {
	const serialized = typeof value === "string" ? value : json(value);
	return Math.ceil(serialized.length / 4);
}

export function estimateTextTokens(value: string): number {
	return estimateValueTokens(value);
}

export function contextFileSource(path: string, cwd: string, home = homedir()): string {
	const file = resolve(path);
	const workingDirectory = resolve(cwd);
	const directory = dirname(file);
	if (directory === workingDirectory) return "current project";
	const fromDirectory = relative(directory, workingDirectory);
	if (fromDirectory && fromDirectory !== ".." && !fromDirectory.startsWith(`..${sep}`)) {
		return "ancestor instructions";
	}
	const fromAgent = relative(resolve(home, ".pi", "agent"), file);
	if (fromAgent && fromAgent !== ".." && !fromAgent.startsWith(`..${sep}`)) return "global agent";
	return "explicit context";
}

export function estimateNextContext(
	systemPrompt: string,
	messages: readonly unknown[],
	toolDefinitions: readonly unknown[],
	contextWindow: number | undefined,
): ContextEstimate {
	const promptTokens = estimateValueTokens(systemPrompt);
	const messageTokens = messages.reduce<number>(
		(total, message) => total + estimateTokens(message as AgentMessage),
		0,
	);
	const toolTokens = toolDefinitions.reduce<number>((total, tool) => total + estimateValueTokens(tool), 0);
	const totalTokens = promptTokens + messageTokens + toolTokens;
	return {
		promptTokens,
		messageTokens,
		toolTokens,
		totalTokens,
		percent: contextWindow && contextWindow > 0 ? (totalTokens / contextWindow) * 100 : undefined,
	};
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
			? "No provider request captured yet. Send one model turn, then return to the payload panel."
			: json(snapshot.payload);
	}
	if (view === "files") {
		return listOrNone(
			(options.contextFiles ?? []).map(
				(file) =>
					`${file.path}\n  source: ${contextFileSource(file.path, options.cwd)} · ~${estimateTextTokens(file.content).toLocaleString()} tokens · ${bytes(file.content)}\n${file.content}`,
			),
		);
	}
	if (view === "skills") {
		return listOrNone(
			(options.skills ?? []).map(
				(skill) =>
					`${skill.name}\n  source: ${skill.sourceInfo.scope} · ~${estimateTextTokens(`${skill.name} ${skill.description}`).toLocaleString()} tokens · model-visible: ${!skill.disableModelInvocation}\n  file: ${skill.filePath}\n  ${skill.description}`,
			),
		);
	}
	if (view === "tools") {
		return json({ selected: options.selectedTools ?? [], snippets: options.toolSnippets ?? {} });
	}

	const usage = snapshot.usage;
	const estimate = estimateNextContext(
		snapshot.systemPrompt,
		snapshot.messages,
		snapshot.toolDefinitions,
		usage?.contextWindow,
	);
	const files = options.contextFiles ?? [];
	const skills = options.skills ?? [];
	const messageBytes = bytes(json(snapshot.messages));
	return [
		"Context inspector",
		`session: ${snapshot.sessionId}`,
		`session file: ${snapshot.sessionFile ?? "(ephemeral)"}`,
		`model: ${snapshot.model ?? "(none)"}`,
		`next request estimate: ~${estimate.totalTokens.toLocaleString()} / ${usage?.contextWindow.toLocaleString() ?? "unknown"} tokens (~${estimate.percent?.toFixed(1) ?? "unknown"}%)`,
		`last measured: ${usage?.tokens?.toLocaleString() ?? "not available yet"} tokens`,
		`breakdown: prompt ~${estimate.promptTokens.toLocaleString()} · messages ~${estimate.messageTokens.toLocaleString()} · tools ~${estimate.toolTokens.toLocaleString()}`,
		`system prompt: ${bytes(snapshot.systemPrompt)}`,
		`conversation: ${snapshot.messages.length} messages, ${messageBytes}`,
		`context files: ${files.length}`,
		`skills loaded: ${skills.length} (${skills.filter((skill) => !skill.disableModelInvocation).length} model-visible)`,
		`tools selected: ${options.selectedTools?.length ?? 0}`,
		`last provider payload: ${snapshot.payloadCapturedAt ?? "not captured"}`,
		"",
		"Panels: summary · files · skills · tools · messages · system · payload",
		"Exactness: payload is the last serialized provider body observed by this extension. System/options are current base inputs; messages are the last model-call context observed by this extension.",
		"Blind spot: extensions loaded after this one may still rewrite the provider payload.",
		"Estimates use Pi's conservative characters/4 heuristic. The provider's tokenizer is authoritative after a request.",
	].join("\n");
}
