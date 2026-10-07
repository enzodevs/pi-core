import type { ImageContent } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { LocalTranslator } from "./backend.js";
import { restoreEnabled, TRANSLATE_ENTRY } from "./state.js";
import { translateText } from "./text.js";

const STATUS = "pi-core-translate";

export default function promptTranslation(pi: ExtensionAPI): void {
	const translator = new LocalTranslator();
	let enabled = false;
	let generation = 0;
	let sessionGeneration = 0;
	let recovery: { text: string; images?: ImageContent[] } | undefined;

	const update = (ctx: ExtensionContext, busy = false) => {
		if (ctx.mode !== "tui") return;
		ctx.ui.setStatus(STATUS, enabled ? ctx.ui.theme.fg("accent", busy ? "PT→EN …" : "PT→EN") : undefined);
	};
	const persist = (value: boolean) => {
		pi.appendEntry(TRANSLATE_ENTRY, { version: 1, enabled: value });
		enabled = value;
	};

	pi.registerCommand("translate", {
		description: "Local PT-BR → English prompt translation for this session only",
		handler: async (args, ctx) => {
			const action = args.trim().toLowerCase() || "status";
			if (action === "status") {
				ctx.ui.notify(
					`Local PT-BR → English translation: ${enabled ? "ON" : "OFF"} (this session only).`,
					"info",
				);
				return;
			}
			if (action === "recover") {
				if (!recovery || ctx.mode !== "tui") {
					ctx.ui.notify("No failed translation draft to recover in this terminal.", "info");
					return;
				}
				if (ctx.ui.getEditorText().trim()) {
					ctx.ui.notify("Clear or park the current editor draft before /translate recover.", "warning");
					return;
				}
				ctx.ui.setEditorText(recovery.text);
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /translate on|off|status|recover", "error");
				return;
			}
			const current = ++generation;
			if (action === "off") {
				persist(false);
				update(ctx);
				await translator.stop();
				ctx.ui.notify("Local prompt translation OFF.", "info");
				return;
			}
			ctx.ui.notify("Loading the local TranslateGemma model…", "info");
			try {
				await translator.start();
				if (current !== generation) return;
				persist(true);
				update(ctx);
				ctx.ui.notify("Local prompt translation ON — only the translated prompt reaches the agent.", "info");
			} catch (error) {
				if (current !== generation) return;
				ctx.ui.notify(
					`Could not enable translation: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
		},
	});

	pi.on("input", async (event, ctx) => {
		if (
			event.source === "extension" ||
			/^\/[^/\s]+(?:\s|$)/u.test(event.text.trimStart()) ||
			event.text.trimStart().startsWith("!")
		) {
			return { action: "continue" };
		}
		const recovered = recovery?.text === event.text ? recovery : undefined;
		const images = event.images ?? recovered?.images;
		if (!enabled || !event.text.trim()) {
			if (recovered) recovery = undefined;
			return recovered?.images ? { action: "transform", text: event.text, images } : { action: "continue" };
		}
		const current = generation;
		const session = sessionGeneration;
		update(ctx, true);
		try {
			const text = await translateText(event.text, (chunk) => translator.translate(chunk, ctx.signal));
			if (current !== generation)
				throw new Error("Session or translation setting changed during translation.");
			if (recovered) recovery = undefined;
			return { action: "transform", text, images };
		} catch (error) {
			if (session !== sessionGeneration) return { action: "handled" };
			recovery = { text: event.text, images };
			if (ctx.mode === "tui" && !ctx.ui.getEditorText().trim()) ctx.ui.setEditorText(event.text);
			ctx.ui.notify(
				`Prompt not sent: ${error instanceof Error ? error.message : String(error)} Original available via /translate recover; use /translate off to bypass.`,
				"error",
			);
			return { action: "handled" };
		} finally {
			if (current === generation) update(ctx);
		}
	});

	pi.on("session_start", (event, ctx) => {
		generation++;
		sessionGeneration++;
		recovery = undefined;
		if (event.reason === "new" || event.reason === "fork") persist(false);
		else enabled = restoreEnabled(ctx.sessionManager.getBranch());
		update(ctx);
	});
	pi.on("session_tree", async (_event, ctx) => {
		generation++;
		sessionGeneration++;
		recovery = undefined;
		enabled = restoreEnabled(ctx.sessionManager.getBranch());
		if (!enabled) await translator.stop();
		update(ctx);
	});
	pi.on("session_shutdown", async (_event, ctx) => {
		generation++;
		sessionGeneration++;
		enabled = false;
		recovery = undefined;
		update(ctx);
		await translator.stop();
	});
}
