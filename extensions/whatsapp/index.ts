import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getStoragePaths } from "../skill-manager/paths.js";
import { type ConnectionStatus, openQrImage } from "./client.js";
import { IsolatedWhatsAppClient } from "./isolated-client.js";
import { boundedTranscript, discoverTranscriber, removePrivateTranscriptionDirectory } from "./transcribe.js";

const TOOL_NAME = "whatsapp";
const STATUS_ID = "pi-core-whatsapp";
const MAX_RESULTS = 20;
const MAX_TRANSCRIPT_REFS = 5;

const WhatsAppParams = Type.Object({
	action: Type.Union(
		[Type.Literal("find"), Type.Literal("transcribe"), Type.Literal("history"), Type.Literal("image")],
		{
			description:
				"Find messages, transcribe audio, view one image, or request older history for a selected chat",
		},
	),
	chat: Type.Optional(
		Type.String({
			description: "Required for find/history: an explicit contact name, phone-number fragment, or chat JID",
			minLength: 3,
			maxLength: 120,
		}),
	),
	kind: Type.Optional(
		Type.Union([Type.Literal("audio"), Type.Literal("text"), Type.Literal("any")], {
			description: "Message kind for find; defaults to audio",
		}),
	),
	since: Type.Optional(
		Type.String({
			description: "Optional ISO date/time lower bound for find, such as 2026-01-01",
			maxLength: 40,
		}),
	),
	before: Type.Optional(
		Type.String({
			pattern: "^wa_[a-f0-9]{16}$",
			description: "Find cursor: use next_before from the previous page",
		}),
	),
	limit: Type.Optional(
		Type.Integer({ description: "Maximum find results; defaults to 10", minimum: 1, maximum: MAX_RESULTS }),
	),
	refs: Type.Optional(
		Type.Array(Type.String({ pattern: "^wa_[a-f0-9]{16}$" }), {
			description: `References from find: up to ${MAX_TRANSCRIPT_REFS} for transcribe, exactly one for image`,
			minItems: 1,
			maxItems: MAX_TRANSCRIPT_REFS,
		}),
	),
});

function statusText(status: ConnectionStatus, count: number): string {
	return `WhatsApp ${status}; ${count} indexed message${count === 1 ? "" : "s"}`;
}

function formatTimestamp(timestamp: number): string {
	return new Date(timestamp * 1_000).toISOString();
}

export default function whatsapp(pi: ExtensionAPI): void {
	const root = join(getStoragePaths().directory, "whatsapp");
	let currentContext: ExtensionContext | undefined;
	let latestStatus: ConnectionStatus = "off";
	let lastQrPath: string | undefined;

	const updateStatus = (ctx = currentContext) => {
		if (!ctx) return;
		ctx.ui.setStatus(
			STATUS_ID,
			latestStatus === "off" ? undefined : `wpp:${latestStatus === "connected" ? "on" : latestStatus}`,
		);
	};
	const client = new IsolatedWhatsAppClient(root, {
		onConnection(status) {
			latestStatus = status;
			updateStatus();
			if (status === "connected")
				currentContext?.ui.notify("WhatsApp connected and indexing messages.", "info");
		},
		onQr(path) {
			lastQrPath = path;
			const opened = openQrImage(path);
			currentContext?.ui.notify(
				opened
					? "WhatsApp pairing QR opened. Scan it with WhatsApp → Linked devices."
					: `Scan the WhatsApp pairing QR at ${path}`,
				"warning",
			);
		},
		onError(message) {
			currentContext?.ui.notify(message, "error");
		},
		onTerminalDisconnect() {
			setToolActive(false);
		},
	});

	const setToolActive = (enabled: boolean) => {
		const active = pi.getActiveTools().filter((name) => name !== TOOL_NAME);
		pi.setActiveTools(enabled ? [...active, TOOL_NAME] : active);
	};

	pi.registerTool({
		name: TOOL_NAME,
		label: "WhatsApp",
		description:
			"Read selected WhatsApp chats with reply context and pagination, transcribe audio locally, or view selected images. History requests older messages from your linked phone; no chat messages are sent.",
		parameters: WhatsAppParams,
		async execute(_toolCallId, params, signal) {
			if (latestStatus !== "connected")
				throw new Error(`WhatsApp is ${latestStatus}; run /wpp on and pair first`);
			if (params.action === "history") {
				if (!params.chat) throw new Error("action=history requires chat");
				return { content: [{ type: "text", text: await client.requestHistory(params.chat) }], details: {} };
			}
			if (params.action === "image") {
				if (params.refs?.length !== 1) throw new Error("action=image requires exactly one ref");
				const image = await client.downloadImage(params.refs[0]);
				return { content: [{ type: "image", ...image }], details: {} };
			}
			if (params.action === "find") {
				if (!params.chat) throw new Error("action=find requires chat");
				const limit = params.limit ?? 10;
				const page = await client.find({
					chat: params.chat,
					kind: params.kind ?? "audio",
					since: params.since,
					before: params.before,
					limit: limit + 1,
				});
				const records = page.slice(0, limit);
				const next = page.length > limit ? records[records.length - 1].ref : undefined;
				const lines = records.map((record) => {
					const duration = record.durationSeconds ? ` duration=${record.durationSeconds}s` : "";
					const sender = record.pushName ? ` sender=${JSON.stringify(record.pushName)}` : "";
					const excerpt = record.text ? ` text=${JSON.stringify(record.text)}` : "";
					const reply = record.reply ? ` reply=${JSON.stringify(record.reply)}` : "";
					return `${record.ref} ${formatTimestamp(record.timestamp)} from=${record.fromMe ? "me" : "contact"} kind=${record.kind}${duration}${sender}${excerpt}${reply}`;
				});
				return {
					content: [
						{
							type: "text",
							text: records.length
								? `${records.length} result(s); ${next ? `next_before=${next}` : "complete (local index only)"}\n${lines.join("\n")}`
								: "0 results (local index only)",
						},
					],
					details: {
						count: records.length,
						complete: !next,
						nextBefore: next,
					} as Record<string, unknown>,
				};
			}
			if (!params.refs?.length) throw new Error("action=transcribe requires refs");
			const transcriber = await discoverTranscriber();
			if (!transcriber) {
				throw new Error(
					"No supported local transcriber found. Install the `whisper` CLI, or install `whisper-cli` and set PI_WPP_WHISPER_MODEL_PATH.",
				);
			}
			const mediaDirectory = join(root, "media");
			await mkdir(mediaDirectory, { recursive: true, mode: 0o700 });
			const transcripts: string[] = [];
			for (const ref of params.refs) {
				if (signal?.aborted) throw new Error("WhatsApp transcription aborted");
				const workDirectory = await mkdtemp(join(mediaDirectory, `${ref}-`));
				const mediaPath = join(workDirectory, `${ref}.ogg`);
				try {
					await client.downloadAudio(ref, mediaPath);
					const result = boundedTranscript(await transcriber.transcribe(mediaPath, workDirectory, signal));
					transcripts.push(`${ref}${result.truncated ? " (truncated)" : ""}: ${result.text}`);
				} finally {
					await removePrivateTranscriptionDirectory(workDirectory);
				}
			}
			return {
				content: [
					{ type: "text", text: `Transcribed locally with ${transcriber.name}\n${transcripts.join("\n\n")}` },
				],
				details: { count: transcripts.length, transcriber: transcriber.name } as Record<string, unknown>,
			};
		},
	});

	pi.registerCommand("wpp", {
		description: "Control WhatsApp: on, off, status, reset (delete local history/login and pair again)",
		handler: async (args, ctx) => {
			currentContext = ctx;
			const action = args.trim().toLowerCase() || "status";
			if (
				!(["on", "off", "status", "reset"] as const).includes(action as "on" | "off" | "status" | "reset")
			) {
				ctx.ui.notify("Usage: /wpp on|off|status|reset", "error");
				return;
			}
			if (action === "reset") {
				setToolActive(false);
				lastQrPath = undefined;
				try {
					await client.reset();
					setToolActive(true);
					ctx.ui.notify(
						"Local WhatsApp history and login deleted. Scan the new QR; retention is 1,000 messages per chat (50,000 total, 100 MiB cap).",
						"info",
					);
				} catch (error) {
					ctx.ui.notify(
						`WhatsApp reset failed: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}
			if (action === "on") {
				setToolActive(true);
				try {
					await client.start();
					ctx.ui.notify("WhatsApp starting. A QR window will open if pairing is required.", "info");
				} catch (error) {
					setToolActive(false);
					ctx.ui.notify(
						`WhatsApp failed to start: ${error instanceof Error ? error.message : String(error)}`,
						"error",
					);
				}
				return;
			}
			if (action === "off") {
				setToolActive(false);
				await client.stop();
				ctx.ui.notify("WhatsApp OFF; its model tool is inactive. Saved pairing remains local.", "info");
				return;
			}
			ctx.ui.notify(
				`${statusText(latestStatus, await client.count())}${lastQrPath && latestStatus === "qr" ? `; QR: ${lastQrPath}` : ""}`,
				"info",
			);
		},
	});

	pi.on("session_start", (_event, ctx) => {
		currentContext = ctx;
		setToolActive(false);
		updateStatus(ctx);
	});
	pi.on("session_shutdown", async () => {
		await client.stop();
		currentContext = undefined;
	});
}
