import {
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

export const DEFAULT_RECAP_DELAY_MS = 3 * 60 * 1000;
export const MIN_RECAP_ASSISTANT_CHARS = 200;
export const RECAP_WIDGET_KEY = "pi-core-recap";
export const RECAP_MODEL_PROVIDER = "openai-codex";
export const RECAP_MODEL_ID = "gpt-5.3-codex-spark";
export const RECAP_PROMPT =
	"Recap where this conversation left off in one short sentence so the user can resume after stepping away. Keep it concise, complete, and untruncated. No preamble or markdown.";
export const RECAP_SYSTEM_PROMPT =
	"Produce one terse factual recap line describing the user's task, completed work, and immediate next step. Do not use tools, preambles, markdown, or quotes.";

export function recapMessages(messages: unknown[]): ReturnType<typeof convertToLlm> {
	return convertToLlm(messages as Parameters<typeof convertToLlm>[0]);
}

export function latestAssistantTextLength(messages: unknown[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index];
		if (!message || typeof message !== "object" || !("role" in message) || message.role !== "assistant") {
			continue;
		}
		if (!("content" in message) || !Array.isArray(message.content)) return 0;
		const text = message.content
			.filter((part): part is { type: "text"; text: string } =>
				Boolean(
					part &&
						typeof part === "object" &&
						"type" in part &&
						part.type === "text" &&
						"text" in part &&
						typeof part.text === "string",
				),
			)
			.map((part) => part.text)
			.join("")
			.trim();
		return Array.from(text).length;
	}
	return 0;
}

export function preferredRecapModel<T>(
	registry: { find(provider: string, modelId: string): T | undefined; hasConfiguredAuth(model: T): boolean },
	activeModel: T,
): T {
	const spark = registry.find(RECAP_MODEL_PROVIDER, RECAP_MODEL_ID);
	return spark && registry.hasConfiguredAuth(spark) ? spark : activeModel;
}

export function normalizeRecap(text: string): string {
	const line = text
		.split(/\r\n|[\n\r]/)
		.map((part) => part.trim())
		.find(Boolean);
	if (!line) return "";

	return line.replace(/^(["'`]|[-*]\s)+|(["'`])$/g, "").replace(/\s+/g, " ");
}

export default function idleRecap(pi: ExtensionAPI): void {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let request: AbortController | undefined;
	let generation = 0;
	let currentCtx: ExtensionContext | undefined;

	const clear = () => {
		generation++;
		if (timer) clearTimeout(timer);
		timer = undefined;
		request?.abort();
		request = undefined;
		currentCtx?.ui.setWidget(RECAP_WIDGET_KEY, undefined);
	};

	const schedule = (ctx: ExtensionContext) => {
		clear();
		currentCtx = ctx;
		if (ctx.mode !== "tui" || !ctx.model) return;
		const scheduledGeneration = generation;
		timer = setTimeout(() => void generate(ctx, scheduledGeneration), DEFAULT_RECAP_DELAY_MS);
		timer.unref?.();
	};

	const generate = async (ctx: ExtensionContext, scheduledGeneration: number) => {
		timer = undefined;
		if (scheduledGeneration !== generation || !ctx.isIdle() || !ctx.model) return;

		const messages = recapMessages(
			buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		);
		if (messages.length === 0 || latestAssistantTextLength(messages) < MIN_RECAP_ASSISTANT_CHARS) return;

		const controller = new AbortController();
		request = controller;
		try {
			const activeModel = ctx.model;
			const model = preferredRecapModel(ctx.modelRegistry, activeModel);
			const context = {
				systemPrompt: RECAP_SYSTEM_PROMPT,
				messages: [
					...messages,
					{
						role: "user" as const,
						content: [{ type: "text" as const, text: RECAP_PROMPT }],
						timestamp: Date.now(),
					},
				],
			};
			const options = {
				reasoningEffort: "low" as const,
				cacheRetention: "none" as const,
				signal: controller.signal,
			};
			const response = await (async () => {
				try {
					return await ctx.modelRegistry.complete(model, context, options);
				} catch (error) {
					if (model === activeModel || controller.signal.aborted) throw error;
					return ctx.modelRegistry.complete(activeModel, context, options);
				}
			})();
			if (scheduledGeneration !== generation || controller.signal.aborted || !ctx.isIdle()) return;
			const text = normalizeRecap(
				response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join(" "),
			);
			if (!text) return;
			ctx.ui.setWidget(
				RECAP_WIDGET_KEY,
				(_tui, theme) =>
					new Text(`${theme.fg("dim", "※")} ${theme.italic(theme.fg("dim", `recap: ${text}`))}`, 0, 0),
				{ placement: "aboveEditor" },
			);
		} catch {
			// Recaps are opportunistic and must never interrupt the session.
		} finally {
			if (request === controller) request = undefined;
		}
	};

	pi.on("session_start", (_event, ctx) => {
		currentCtx = ctx;
		clear();
	});
	pi.on("input", () => clear());
	pi.on("agent_start", () => clear());
	pi.on("agent_settled", (_event, ctx) => schedule(ctx));
	pi.on("session_tree", (_event, ctx) => schedule(ctx));
	pi.on("session_shutdown", () => clear());
}
