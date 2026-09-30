import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname } from "node:path";
import { type ExtensionAPI, type ExtensionContext, isReadToolResult } from "@earendil-works/pi-coding-agent";
import {
	addNestedGuides,
	projectRoot,
	READ_SCOPE_KEY,
	resolveReadTarget,
	type StartupGuide,
} from "./core.js";

export default function nestedAgents(pi: ExtensionAPI): void {
	let override: boolean | undefined;
	let root: string | undefined;
	let startup: StartupGuide[] = [];
	let contextAvailable = false;
	const enabled = () => override ?? pi.getFlag("nested-agents") === true;
	const allowed = (ctx: ExtensionContext) =>
		enabled() && ctx.isProjectTrusted() && contextAvailable && root !== undefined;

	pi.registerFlag("nested-agents", {
		description: "Opt in to bounded, project-contained nested guides on successful reads",
		type: "boolean",
		default: false,
	});
	pi.registerCommand("nested-agents", {
		description: "Control read-triggered project guidance: on, off, status",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (!["on", "off", "status"].includes(action)) {
				ctx.ui.notify("Usage: /nested-agents on|off|status", "error");
				return;
			}
			if (action !== "status") override = action === "on";
			ctx.ui.notify(
				`Nested guides ${enabled() ? "ON" : "OFF"}; requires trusted project and nonempty startup context; ${root ?? "project not initialized"}.`,
				"info",
			);
		},
	});
	pi.on("session_start", async (_event, ctx) => {
		root = undefined;
		startup = [];
		contextAvailable = false;
		override = undefined;
		try {
			const candidate = await projectRoot(ctx.cwd);
			if (candidate !== (await realpath(homedir())) && dirname(candidate) !== candidate) root = candidate;
		} catch {
			// An unavailable startup directory disables discovery without affecting reads.
		}
	});
	pi.on("before_agent_start", (event) => {
		startup = event.systemPromptOptions.contextFiles.map((guide) => ({ ...guide }));
		// noContextFiles is not exposed in ExtensionContext. Empty context is fail-closed.
		contextAvailable = startup.length > 0 && !event.systemPromptOptions.forceSystemPrompt;
	});
	pi.on("tool_result", async (event, ctx) => {
		if (!allowed(ctx) || !isReadToolResult(event) || event.isError || typeof event.input.path !== "string")
			return;
		// Nested calls are not transcript messages, so their read scope must not leak via a parent.
		if (event.parentToolCallId) return;
		const activeRoot = root;
		try {
			const path = await resolveReadTarget(event.input.path, ctx.cwd);
			if (!path) return;
			return {
				details: { ...event.details, [READ_SCOPE_KEY]: { root: activeRoot, path } },
			};
		} catch {
			// Preserve all original result content, error state, usage and details on failure.
		}
	});
	pi.on("context", async (event, ctx) => {
		if (!allowed(ctx) || !root) return;
		return { messages: await addNestedGuides(event.messages, root, startup) };
	});
}
