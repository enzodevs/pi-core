import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getStoragePaths } from "../skill-manager/paths.js";
import {
	type FastAction,
	type FastTier,
	loadFastModeState,
	nextFastModeState,
	resolveServiceTier,
	saveFastModeState,
	withServiceTier,
} from "./state.js";

const STATUS_ID = "pi-core-fast-mode";
const TIER_LABELS: Record<FastTier, string> = { priority: "fast", ultrafast: "ultrafast" };

/** API-key requests stay untouched: these tiers would bill them at premium rates. */
function isSubscriptionCodex(ctx: ExtensionContext): boolean {
	const model = ctx.model;
	if (!model) return false;
	if (model.api === "openai-codex-responses") return true;
	return (
		model.provider === "openai" && model.api === "openai-responses" && ctx.modelRegistry.isUsingOAuth(model)
	);
}

export default async function fastMode(pi: ExtensionAPI) {
	const statePath = join(getStoragePaths().directory, "fast-mode.json");
	let state = await loadFastModeState(statePath);

	const activeTier = (ctx: ExtensionContext) =>
		isSubscriptionCodex(ctx) ? resolveServiceTier(state, ctx.model?.id) : undefined;

	const updateStatus = (ctx: ExtensionContext) => {
		const tier = activeTier(ctx);
		ctx.ui.setStatus(STATUS_ID, tier ? ctx.ui.theme.fg("warning", `⚡ ${TIER_LABELS[tier]}`) : undefined);
	};

	const registerTierCommand = (name: string, tier: FastTier, description: string, consequence: string) => {
		pi.registerCommand(name, {
			description,
			handler: async (args, ctx) => {
				const action = args.trim().toLowerCase();
				if (action === "status") {
					const active = activeTier(ctx);
					ctx.ui.notify(
						state.enabled
							? `Speed mode requested: ${TIER_LABELS[state.tier]}. Active now: ${active ? TIER_LABELS[active] : "none (current model is not on a ChatGPT subscription login)"}.`
							: "Speed mode is OFF.",
						"info",
					);
					return;
				}
				if (action && action !== "on" && action !== "off") {
					ctx.ui.notify(`Usage: /${name} [on|off|status]`, "error");
					return;
				}
				state = nextFastModeState(state, tier, action as FastAction);
				await saveFastModeState(statePath, state);
				updateStatus(ctx);
				if (!state.enabled) {
					ctx.ui.notify(
						"Speed mode OFF — subsequent requests use the provider default service tier.",
						"info",
					);
					return;
				}
				const active = activeTier(ctx);
				const note =
					active === tier
						? ""
						: active
							? ` ${ctx.model?.id} does not offer ${TIER_LABELS[tier]}, so it uses ${TIER_LABELS[active]}.`
							: " Inactive until you select a model on a ChatGPT subscription login.";
				ctx.ui.notify(`${TIER_LABELS[tier]} ON — ${consequence}${note}`, "warning");
			},
		});
	};

	registerTierCommand(
		"fast",
		"priority",
		"Toggle OpenAI Fast mode (priority processing) for this and future sessions",
		"subsequent requests use priority processing and more plan usage.",
	);
	registerTierCommand(
		"ultrafast",
		"ultrafast",
		"Toggle OpenAI Ultrafast mode for this and future sessions",
		"subsequent requests consume plan usage much faster.",
	);

	pi.on("before_provider_request", (event, ctx) => {
		const tier = activeTier(ctx);
		return tier ? withServiceTier(event.payload, tier) : undefined;
	});

	pi.on("session_start", (_event, ctx) => updateStatus(ctx));
	pi.on("model_select", (_event, ctx) => updateStatus(ctx));
	pi.on("session_shutdown", (_event, ctx) => ctx.ui.setStatus(STATUS_ID, undefined));
}
