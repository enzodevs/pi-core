import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth } from "@earendil-works/pi-tui";

export function interstellarHeader(theme: Theme, width: number): string[] {
	const mark = width >= 44 ? "◌  π  ◌" : "π";
	const title = width >= 44 ? "PI  /  INTERSTELLAR" : "PI / INTERSTELLAR";
	const subtitle = width >= 66 ? "coding agent · clear intent" : "coding agent";

	return [
		truncateToWidth(theme.fg("accent", `  ${mark}`), width, ""),
		truncateToWidth(theme.fg("text", theme.bold(`  ${title}`)), width, ""),
		truncateToWidth(theme.fg("dim", `  ${subtitle}`), width, ""),
	];
}

export default function interstellar(pi: ExtensionAPI): void {
	pi.on("session_start", (_event, ctx) => {
		if (ctx.mode !== "tui") return;

		ctx.ui.setTitle("π · Interstellar");
		ctx.ui.setHeader((_tui, theme) => ({
			render(width: number): string[] {
				return interstellarHeader(theme, width);
			},
			invalidate() {},
		}));
		ctx.ui.setWorkingMessage("navigating the black");
		ctx.ui.setWorkingIndicator({
			frames: [
				ctx.ui.theme.fg("dim", "·"),
				ctx.ui.theme.fg("muted", "∙"),
				ctx.ui.theme.fg("accent", "●"),
				ctx.ui.theme.fg("muted", "∙"),
			],
			intervalMs: 130,
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		ctx.ui.setHeader(undefined);
		ctx.ui.setWorkingMessage();
		ctx.ui.setWorkingIndicator();
	});
}
