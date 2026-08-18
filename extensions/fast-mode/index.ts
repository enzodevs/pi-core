import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getStoragePaths } from "../skill-manager/paths.js";
import { loadFastModeState, saveFastModeState, withPriorityServiceTier } from "./state.js";

const STATUS_ID = "pi-core-fast-mode";

function isOpenAICodex(ctx: ExtensionContext): boolean {
	return ctx.model?.provider === "openai-codex";
}

export default async function fastMode(pi: ExtensionAPI) {
	const statePath = join(getStoragePaths().directory, "fast-mode.json");
	let state = await loadFastModeState(statePath);

	const updateStatus = (ctx: ExtensionContext) => {
		ctx.ui.setStatus(
			STATUS_ID,
			state.enabled && isOpenAICodex(ctx) ? ctx.ui.theme.fg("warning", "⚡ fast") : undefined,
		);
	};

	pi.registerCommand("fast", {
		description: "Toggle OpenAI Fast mode (priority processing) for this and future sessions",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase();
			if (action && !["on", "off", "status"].includes(action)) {
				ctx.ui.notify("Usage: /fast [on|off|status]", "error");
				return;
			}
			if (action === "status") {
				ctx.ui.notify(
					`Fast mode is ${state.enabled ? "ON" : "OFF"}${isOpenAICodex(ctx) ? "" : " (inactive on the current non-Codex provider)"}.`,
					"info",
				);
				return;
			}
			const enabled = action === "on" || (action === "" && !state.enabled);
			state = { version: 1, enabled };
			await saveFastModeState(statePath, state);
			updateStatus(ctx);
			ctx.ui.notify(
				enabled
					? "Fast mode ON — subsequent OpenAI Codex requests use priority processing at premium pricing."
					: "Fast mode OFF — subsequent requests use the provider default service tier.",
				enabled ? "warning" : "info",
			);
		},
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!state.enabled || !isOpenAICodex(ctx)) return;
		return withPriorityServiceTier(event.payload);
	});

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_ID, undefined));
}
