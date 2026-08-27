import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	type ContextProjectionStats,
	DEFAULT_CONTEXT_GUARD_CONFIG,
	projectToolContext,
} from "./compressor.ts";

const STATUS_ID = "pi-core-context-guard";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function emptyStats(): ContextProjectionStats {
	return { toolResults: 0, compressedResults: 0, originalBytes: 0, projectedBytes: 0 };
}

export default function contextGuard(pi: ExtensionAPI): void {
	let latest = emptyStats();

	pi.on("session_start", () => {
		latest = emptyStats();
	});

	pi.on("context", (event) => {
		const projection = projectToolContext(event.messages);
		latest = projection.stats;
		return { messages: projection.messages };
	});

	pi.registerCommand("context-guard", {
		description: "Show the current tool-output context projection",
		handler: async (_args, ctx) => {
			const saved = Math.max(0, latest.originalBytes - latest.projectedBytes);
			const percent = latest.originalBytes > 0 ? Math.round((saved / latest.originalBytes) * 100) : 0;
			ctx.ui.notify(
				latest.toolResults === 0
					? "Context guard: no tool results in the current model context."
					: `Context guard: ${latest.compressedResults}/${latest.toolResults} results compressed · ${formatBytes(
							latest.originalBytes,
						)} → ${formatBytes(latest.projectedBytes)} (${percent}% saved) · ${formatBytes(
							DEFAULT_CONTEXT_GUARD_CONFIG.totalToolBytes,
						)} rolling budget`,
				"info",
			);
			ctx.ui.setStatus(STATUS_ID, undefined);
		},
	});
}
