import { constants } from "node:fs";
import { access } from "node:fs/promises";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { compressJson, headroomPython } from "./bridge.js";
import { compactToolResult } from "./compact.js";
import { saveOriginal } from "./originals.js";
import { getHeadroomPaths } from "./paths.mjs";

export default function jsonHeadroom(pi: ExtensionAPI): void {
	let override: boolean | undefined;
	const enabled = () => override ?? pi.getFlag("headroom-json") === true;
	const directory = getHeadroomPaths().originals;
	const status = (ctx: ExtensionContext) => {
		ctx.ui.setStatus("pi-core-json-headroom", enabled() ? "JSON: lossless pilot" : undefined);
	};
	pi.registerFlag("headroom-json", {
		description: "Opt in to local lossless Headroom compaction of large JSON bash results",
		type: "boolean",
		default: false,
	});
	pi.registerCommand("headroom-json", {
		description: "Control the opt-in JSON compaction pilot: on, off, status",
		handler: async (args, ctx) => {
			const action = args.trim() || "status";
			if (!["on", "off", "status"].includes(action)) {
				ctx.ui.notify("Usage: /headroom-json on|off|status", "error");
				return;
			}
			if (action === "on") {
				try {
					await access(headroomPython(), constants.X_OK);
				} catch {
					ctx.ui.notify("Headroom runtime unavailable. Run make headroom-install in pi-core first.", "error");
					return;
				}
			}
			if (action !== "status") override = action === "on";
			status(ctx);
			ctx.ui.notify(
				`JSON pilot ${enabled() ? "ON" : "OFF"}; local lossless-only, bash results only.`,
				"info",
			);
		},
	});
	pi.on("session_start", (_event, ctx) => status(ctx));
	pi.on("tool_result", (event, ctx) => {
		if (!enabled()) return;
		return compactToolResult(
			event,
			{ compress: compressJson, save: (text) => saveOriginal(directory, text) },
			ctx.signal,
		);
	});
}
