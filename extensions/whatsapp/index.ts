import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getStoragePaths } from "../skill-manager/paths.js";
import { type ConnectionStatus, openQrImage, WhatsAppClient } from "./client.js";
import { boundedTranscript, discoverTranscriber, removePrivateTranscriptionDirectory } from "./transcribe.js";

const TOOL_NAME = "whatsapp";
const STATUS_ID = "pi-core-whatsapp";
const MAX_RESULTS = 20;
const MAX_TRANSCRIPT_REFS = 5;

const WhatsAppParams = Type.Object({
	action: Type.Union([Type.Literal("find"), Type.Literal("transcribe")], {
		description: "Find message references or locally transcribe previously found audio references",
	}),
	chat: Type.Optional(
		Type.String({
			description: "Required for find: an explicit contact name, phone-number fragment, or chat JID",
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
	limit: Type.Optional(
		Type.Integer({ description: "Maximum find results; defaults to 10", minimum: 1, maximum: MAX_RESULTS }),
	),
	refs: Type.Optional(
		Type.Array(Type.String({ pattern: "^wa_[a-f0-9]{16}$" }), {
			description: `Required for transcribe: opaque audio references from find (maximum ${MAX_TRANSCRIPT_REFS})`,
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
	const client = new WhatsAppClient(root, {
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
			"Read explicitly selected local WhatsApp messages without sending messages. Find returns bounded opaque references; transcribe downloads selected audio privately and returns bounded local transcripts.",
		parameters: WhatsAppParams,
		async execute(_toolCallId, params, signal) {
			if (latestStatus !== "connected")
				throw new Error(`WhatsApp is ${latestStatus}; run /wpp on and pair first`);
			if (params.action === "find") {
				if (!params.chat) throw new Error("action=find requires chat");
				const records = client.index.find({
					chat: params.chat,
					kind: params.kind ?? "audio",
					since: params.since,
					limit: params.limit ?? 10,
				});
				const lines = records.map((record) => {
					const duration = record.durationSeconds ? ` duration=${record.durationSeconds}s` : "";
					const sender = record.pushName ? ` sender=${JSON.stringify(record.pushName)}` : "";
					const excerpt = record.text ? ` text=${JSON.stringify(record.text)}` : "";
					return `${record.ref} ${formatTimestamp(record.timestamp)} kind=${record.kind}${duration}${sender}${excerpt}`;
				});
				return {
					content: [
						{
							type: "text",
							text: records.length ? `${records.length} result(s)\n${lines.join("\n")}` : "0 results",
						},
					],
					details: {
						count: records.length,
						complete: records.length < (params.limit ?? 10),
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
		description: "Control private read-only WhatsApp access: on, off, status",
		handler: async (args, ctx) => {
			currentContext = ctx;
			const action = args.trim().toLowerCase() || "status";
			if (!(["on", "off", "status"] as const).includes(action as "on" | "off" | "status")) {
				ctx.ui.notify("Usage: /wpp on|off|status", "error");
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
				`${statusText(latestStatus, client.index.count())}${lastQrPath && latestStatus === "qr" ? `; QR: ${lastQrPath}` : ""}`,
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
