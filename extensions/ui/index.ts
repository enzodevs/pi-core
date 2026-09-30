import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/** Keep native surfaces and progress text, without an animated working indicator. */
export default function interfaceDefaults(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWorkingIndicator({ frames: [] });
	});
	pi.on("session_shutdown", (_event, ctx) => {
		if (ctx.mode === "tui") ctx.ui.setWorkingIndicator();
	});
}
