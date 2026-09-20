import { spawn } from "node:child_process";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import makeWASocket, {
	Browsers,
	DisconnectReason,
	downloadMediaMessage,
	normalizeMessageContent,
	proto,
	toNumber,
	useMultiFileAuthState,
	type WAMessage,
	type WASocket,
} from "@whiskeysockets/baileys";
import pino from "pino";
import QRCode from "qrcode";
import { type ConsoleFilter, suppressLibsignalConsole } from "./libsignal-console.js";
import { MessageIndex, messageReference, truncateMessageText, type WhatsAppMessageRecord } from "./store.js";

const logger = pino({ level: "silent" });
const MAX_ENCODED_MESSAGE_BYTES = 512 * 1024;

export interface WhatsAppClientCallbacks {
	onConnection(state: ConnectionStatus): void;
	onQr(path: string): void;
	onError(message: string): void;
	onTerminalDisconnect(): void;
}

export type ConnectionStatus = "off" | "connecting" | "qr" | "connected" | "disconnected";

function disconnectCode(error: unknown): number | undefined {
	if (!error || typeof error !== "object") return undefined;
	const output = (error as { output?: { statusCode?: number } }).output;
	return output?.statusCode;
}

function contentDetails(
	message: WAMessage,
): Pick<WhatsAppMessageRecord, "kind" | "text" | "durationSeconds"> {
	const content = normalizeMessageContent(message.message);
	if (!content) return { kind: "unknown" };
	if (content.audioMessage) {
		return { kind: "audio", durationSeconds: content.audioMessage.seconds ?? undefined };
	}
	const text =
		content.conversation ??
		content.extendedTextMessage?.text ??
		content.imageMessage?.caption ??
		content.videoMessage?.caption ??
		content.documentMessage?.caption ??
		undefined;
	return { kind: text ? "text" : "other", text: truncateMessageText(text ?? undefined) };
}

export function messageToRecord(message: WAMessage): WhatsAppMessageRecord | undefined {
	const chatJid = message.key.remoteJid;
	const messageId = message.key.id;
	if (!chatJid || !messageId || chatJid === "status@broadcast") return undefined;
	const details = contentDetails(message);
	const encoded =
		details.kind === "audio" ? Buffer.from(proto.WebMessageInfo.encode(message).finish()) : undefined;
	return {
		ref: messageReference(chatJid, messageId),
		messageId,
		chatJid,
		participant: message.key.participant ?? undefined,
		pushName: message.pushName ?? undefined,
		fromMe: message.key.fromMe === true,
		timestamp: toNumber(message.messageTimestamp),
		...details,
		encodedMessage:
			encoded && encoded.byteLength <= MAX_ENCODED_MESSAGE_BYTES ? encoded.toString("base64") : undefined,
	};
}

export class WhatsAppClient {
	readonly #root: string;
	readonly #authDirectory: string;
	readonly #qrPath: string;
	readonly #index: MessageIndex;
	readonly #callbacks: WhatsAppClientCallbacks;
	#socket?: WASocket;
	#status: ConnectionStatus = "off";
	#requested = false;
	#reconnectTimer?: NodeJS.Timeout;
	#consoleFilter?: ConsoleFilter;

	constructor(root: string, callbacks: WhatsAppClientCallbacks) {
		this.#root = root;
		this.#authDirectory = join(root, "auth");
		this.#qrPath = join(root, "pairing-qr.png");
		this.#index = new MessageIndex(join(root, "messages.jsonl"));
		this.#callbacks = callbacks;
	}

	get index(): MessageIndex {
		return this.#index;
	}

	async start(): Promise<void> {
		if (this.#requested) return;
		this.#requested = true;
		await mkdir(this.#root, { recursive: true, mode: 0o700 });
		await chmod(this.#root, 0o700);
		await this.#index.load();
		this.#consoleFilter ??= suppressLibsignalConsole();
		try {
			await this.#connect();
		} catch (error) {
			this.#requested = false;
			this.#consoleFilter.restore();
			this.#consoleFilter = undefined;
			throw error;
		}
	}

	async stop(): Promise<void> {
		this.#requested = false;
		if (this.#reconnectTimer) clearTimeout(this.#reconnectTimer);
		this.#reconnectTimer = undefined;
		this.#socket?.end(undefined);
		this.#socket = undefined;
		await rm(this.#qrPath, { force: true });
		this.#consoleFilter?.restore();
		this.#consoleFilter = undefined;
		this.#setStatus("off");
	}

	async downloadAudio(ref: string, destination: string): Promise<void> {
		const record = this.#index.get(ref);
		if (!record) throw new Error(`Unknown WhatsApp reference: ${ref}`);
		if (record.kind !== "audio") throw new Error(`${ref} is not an audio message`);
		if (!record.encodedMessage) throw new Error(`${ref} has no retained media descriptor`);
		if (!this.#socket || this.#status !== "connected") throw new Error("WhatsApp is not connected");
		const message = proto.WebMessageInfo.decode(Buffer.from(record.encodedMessage, "base64"));
		const media = await downloadMediaMessage(
			message,
			"buffer",
			{},
			{
				logger,
				reuploadRequest: this.#socket.updateMediaMessage,
			},
		);
		await mkdir(join(this.#root, "media"), { recursive: true, mode: 0o700 });
		const { writeFile } = await import("node:fs/promises");
		await writeFile(destination, media, { mode: 0o600 });
	}

	async #connect(): Promise<void> {
		if (!this.#requested) return;
		this.#setStatus("connecting");
		await mkdir(this.#authDirectory, { recursive: true, mode: 0o700 });
		await chmod(this.#authDirectory, 0o700);
		const { state, saveCreds } = await useMultiFileAuthState(this.#authDirectory);
		if (!this.#requested) return;
		const socket = makeWASocket({
			auth: state,
			browser: Browsers.appropriate("Pi Core"),
			logger,
			markOnlineOnConnect: false,
			// Full history is useful only while pairing; replaying it on every reconnect
			// causes unnecessary stale Signal-session decrypt attempts.
			syncFullHistory: !state.creds.registered,
			generateHighQualityLinkPreview: false,
		});
		this.#socket = socket;
		socket.ev.on("creds.update", saveCreds);
		socket.ev.on("messages.upsert", ({ messages }) => void this.#ingest(messages));
		socket.ev.on("messaging-history.set", ({ messages }) => void this.#ingest(messages));
		socket.ev.on("connection.update", (update) => void this.#handleConnectionUpdate(socket, update));
	}

	async #ingest(messages: WAMessage[]): Promise<void> {
		try {
			const records = messages.map(messageToRecord).filter((record) => record !== undefined);
			await this.#index.add(records);
		} catch (error) {
			this.#callbacks.onError(
				`WhatsApp indexing failed: ${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	async #handleConnectionUpdate(
		socket: WASocket,
		update: { connection?: "close" | "open" | "connecting"; lastDisconnect?: { error?: Error }; qr?: string },
	): Promise<void> {
		if (socket !== this.#socket || !this.#requested) return;
		if (update.qr) {
			await QRCode.toFile(this.#qrPath, update.qr, { width: 420, margin: 2 });
			await chmod(this.#qrPath, 0o600);
			this.#setStatus("qr");
			this.#callbacks.onQr(this.#qrPath);
		}
		if (update.connection === "open") {
			await rm(this.#qrPath, { force: true });
			this.#setStatus("connected");
			return;
		}
		if (update.connection !== "close") return;
		this.#socket = undefined;
		const code = disconnectCode(update.lastDisconnect?.error);
		if (code === DisconnectReason.loggedOut) {
			this.#requested = false;
			await rm(this.#qrPath, { force: true });
			this.#consoleFilter?.restore();
			this.#consoleFilter = undefined;
			this.#setStatus("disconnected");
			this.#callbacks.onTerminalDisconnect();
			this.#callbacks.onError("WhatsApp logged out. Remove the saved auth directory before pairing again.");
			return;
		}
		this.#setStatus("disconnected");
		this.#reconnectTimer = setTimeout(() => {
			this.#reconnectTimer = undefined;
			void this.#connect().catch((error: unknown) =>
				this.#callbacks.onError(
					`WhatsApp reconnect failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		}, 2_000);
	}

	#setStatus(status: ConnectionStatus): void {
		this.#status = status;
		this.#callbacks.onConnection(status);
	}
}

export function openQrImage(path: string): boolean {
	try {
		const child = spawn("xdg-open", [path], { detached: true, stdio: "ignore" });
		child.once("error", () => undefined);
		child.unref();
		return true;
	} catch {
		return false;
	}
}
