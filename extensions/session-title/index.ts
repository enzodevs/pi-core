import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";

export const SESSION_TITLE_MODEL_PROVIDER = "openai-codex";
export const SESSION_TITLE_MODEL_ID = "gpt-5.3-codex-spark";
export const SESSION_TITLE_MAX_SOURCE_CHARS = 1_200;
export const SESSION_TITLE_MAX_CHARS = 64;
export const SESSION_TITLE_SYSTEM_PROMPT =
	"Create a short display title for a coding-agent conversation. Return only the title: 2 to 5 words, no quotes, markdown, or ending punctuation. Prefer direct verbs and plain language. Describe the user's concrete objective; avoid generic titles such as Coding Help or New Session.";

interface MessageLike {
	role?: unknown;
	content?: unknown;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
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
		.join("\n")
		.trim();
}

function bounded(text: string): string {
	const characters = Array.from(text.replace(/\s+/g, " ").trim());
	return characters.slice(0, SESSION_TITLE_MAX_SOURCE_CHARS).join("");
}

export function firstExchange(messages: unknown[]): { user: string; assistant: string } | undefined {
	let user = "";
	for (const value of messages) {
		if (!value || typeof value !== "object") continue;
		const message = value as MessageLike;
		const text = textContent(message.content);
		if (!text) continue;
		if (!user && message.role === "user") {
			user = bounded(text);
			continue;
		}
		if (user && message.role === "assistant") return { user, assistant: bounded(text) };
	}
	return undefined;
}

export function preferredSessionTitleModel<T>(
	registry: { find(provider: string, modelId: string): T | undefined; hasConfiguredAuth(model: T): boolean },
	activeModel: T,
): T {
	const spark = registry.find(SESSION_TITLE_MODEL_PROVIDER, SESSION_TITLE_MODEL_ID);
	return spark && registry.hasConfiguredAuth(spark) ? spark : activeModel;
}

export function normalizeSessionTitle(text: string): string {
	const line = text
		.split(/\r\n|[\n\r]/)
		.map((part) => part.trim())
		.find(Boolean);
	if (!line) return "";
	const title = line
		.replace(/^(?:title\s*:\s*)/i, "")
		.replace(/^["'`*_#\s-]+|["'`*_#\s.!?,:;]+$/g, "")
		.replace(/\s+/g, " ");
	const words = title.split(" ").filter(Boolean);
	if (words.length < 2 || words.length > 5 || Array.from(title).length > SESSION_TITLE_MAX_CHARS) return "";
	return title;
}

export default function sessionTitle(pi: ExtensionAPI): void {
	let generation = 0;
	let request: AbortController | undefined;

	const cancel = () => {
		generation++;
		request?.abort();
		request = undefined;
	};

	const generate = async (ctx: ExtensionContext) => {
		if (pi.getSessionName() || !ctx.model || request) return;
		const exchange = firstExchange(
			buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
		);
		if (!exchange) return;

		const startedAt = generation;
		const controller = new AbortController();
		request = controller;
		try {
			const activeModel = ctx.model;
			const model = preferredSessionTitleModel(ctx.modelRegistry, activeModel);
			const context = {
				systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
				messages: [
					{
						role: "user" as const,
						content: [
							{
								type: "text" as const,
								text: `User request:\n${exchange.user}\n\nAssistant response:\n${exchange.assistant}`,
							},
						],
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
			if (startedAt !== generation || controller.signal.aborted || pi.getSessionName()) return;
			const title = normalizeSessionTitle(
				response.content
					.filter((part): part is { type: "text"; text: string } => part.type === "text")
					.map((part) => part.text)
					.join(" "),
			);
			if (title) pi.setSessionName(title);
		} catch {
			// Automatic naming is opportunistic and must never interrupt the session.
		} finally {
			if (request === controller) request = undefined;
		}
	};

	pi.on("session_start", cancel);
	pi.on("session_before_switch", cancel);
	pi.on("session_before_fork", cancel);
	pi.on("session_before_tree", cancel);
	pi.on("session_info_changed", cancel);
	pi.on("input", cancel);
	pi.on("agent_settled", (_event, ctx) => void generate(ctx));
	pi.on("session_tree", (_event, ctx) => void generate(ctx));
	pi.on("session_shutdown", cancel);
}
