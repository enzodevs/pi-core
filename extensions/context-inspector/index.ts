import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getSkillMode, loadConfig } from "../skill-manager/config.js";
import { getStoragePaths } from "../skill-manager/paths.js";
import { resolveProjectRoot } from "../skill-manager/project-root.js";
import { CONTEXT_VIEWS, renderContextView } from "./core.js";
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
		description: "Open the model context dashboard",
		handler: async (args, ctx) => {
			if (args.trim()) {
				ctx.ui.notify("Usage: /context", "error");
				return;
			}
			const options = ctx.getSystemPromptOptions();
			const [config, project] = await Promise.all([
				loadConfig(getStoragePaths().config),
				resolveProjectRoot(ctx.cwd),
			]);
			const skillModes = new Map(
				(options.skills ?? []).map((skill) => [skill.name, getSkillMode(config, project, skill.name)]),
			);
			const effectiveSkills = (options.skills ?? []).filter((skill) => {
				const mode = skillModes.get(skill.name) ?? "full";
				return !skill.disableModelInvocation && (mode === "full" || mode === "name");
			});
			// Inspect the actual rendered prompt; skill-manager now owns a structured
			// skills section, so synthesizing another block would duplicate it.
			const effectiveSystemPrompt = ctx.getSystemPrompt();
			const snapshot = {
				usage: ctx.getContextUsage(),
				systemPrompt: effectiveSystemPrompt,
				options: { ...options, skills: effectiveSkills },
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
			const contents = Object.fromEntries(
				CONTEXT_VIEWS.map((view) => [view, renderContextView(view, snapshot)]),
			) as Record<(typeof CONTEXT_VIEWS)[number], string>;
			if (ctx.mode === "tui") {
				await showContextInspector(ctx, "summary", {
					options,
					messages: lastMessages,
					contents,
					skillModes,
				});
			} else ctx.ui.notify(contents.summary, "info");
		},
	});
}
