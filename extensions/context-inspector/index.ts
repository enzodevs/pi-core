import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CONTEXT_VIEWS, parseContextView, renderContextView } from "./core.js";
import { showContextInspector } from "./ui.js";

export default function contextInspector(pi: ExtensionAPI): void {
	let lastPayload: unknown;
	let payloadCapturedAt: string | undefined;
	let lastMessages: unknown[] = [];

	pi.on("context", (event) => {
		lastMessages = structuredClone(event.messages);
	});

	pi.on("before_provider_request", (event) => {
		lastPayload = event.payload;
		payloadCapturedAt = new Date().toISOString();
	});

	pi.registerCommand("context", {
		description: "Inspect model context, prompt inputs, files, skills, tools, and provider payload",
		getArgumentCompletions: (prefix) => {
			const matches = CONTEXT_VIEWS.filter((view) => view.startsWith(prefix));
			return matches.length > 0 ? matches.map((view) => ({ value: view, label: view })) : null;
		},
		handler: async (args, ctx) => {
			const view = parseContextView(args);
			if (!view) {
				ctx.ui.notify(`Usage: /context ${CONTEXT_VIEWS.join("|")}`, "error");
				return;
			}
			const options = ctx.getSystemPromptOptions();
			const snapshot = {
				usage: ctx.getContextUsage(),
				systemPrompt: ctx.getSystemPrompt(),
				options,
				messages: lastMessages,
				payload: lastPayload,
				payloadCapturedAt,
				sessionId: ctx.sessionManager.getSessionId(),
				sessionFile: ctx.sessionManager.getSessionFile(),
				model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
				toolDefinitions: pi
					.getAllTools()
					.filter((tool) => pi.getActiveTools().includes(tool.name))
					.map(({ name, description, parameters }) => ({ name, description, parameters })),
			};
			const content = renderContextView(view, snapshot);
			if (ctx.mode === "tui")
				await showContextInspector(ctx, view, content, { options, messages: lastMessages });
			else ctx.ui.notify(content, "info");
		},
	});
}
