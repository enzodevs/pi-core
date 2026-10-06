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
import {
	type ContactIdentity,
	ContactIndex,
	MessageIndex,
	messageReference,
	truncateMessageText,
	type WhatsAppMessageRecord,
} from "./store.js";

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
	message: proto.IWebMessageInfo,
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
	return {
		kind: content.imageMessage ? "image" : text ? "text" : "other",
		text: truncateMessageText(text ?? undefined),
	};
}

export function messageToRecord(message: proto.IWebMessageInfo): WhatsAppMessageRecord | undefined {
	const key = message.key as WAMessage["key"] | null | undefined;
	const chatJid = key?.remoteJid;
	const messageId = key?.id;
	if (!chatJid || !messageId || chatJid === "status@broadcast") return undefined;
	const details = contentDetails(message);
	const content = normalizeMessageContent(message.message);
	const context =
		content?.extendedTextMessage?.contextInfo ??
		content?.imageMessage?.contextInfo ??
		content?.audioMessage?.contextInfo ??
		content?.videoMessage?.contextInfo ??
		content?.documentMessage?.contextInfo ??
		content?.stickerMessage?.contextInfo;
	const quoted = context?.quotedMessage ? contentDetails({ message: context.quotedMessage }) : undefined;
	const reply =
		context?.stanzaId || quoted
			? {
					ref: context?.stanzaId
						? messageReference(context.remoteJid || chatJid, context.stanzaId)
						: undefined,
					participant: context?.participant ?? undefined,
					kind: quoted?.kind ?? "unknown",
					text: quoted?.text,
				}
			: undefined;
	const encoded =
		details.kind === "audio" || details.kind === "image"
			? Buffer.from(proto.WebMessageInfo.encode(message).finish())
			: undefined;
	return {
		ref: messageReference(chatJid, messageId),
		messageId,
		chatJid,
		participant: key?.participant ?? undefined,
		chatJidAlt: key?.remoteJidAlt,
		participantAlt: key?.participantAlt,
		pushName: message.pushName ?? undefined,
		fromMe: key?.fromMe === true,
		timestamp: toNumber(message.messageTimestamp),
		...details,
		reply,
		encodedMessage:
			encoded && encoded.byteLength <= MAX_ENCODED_MESSAGE_BYTES ? encoded.toString("base64") : undefined,
	};
}

export class WhatsAppClient {
	readonly #root: string;
	readonly #authDirectory: string;
	readonly #qrPath: string;
	readonly #contactsPath: string;
	readonly #index: MessageIndex;
	readonly #contacts = new ContactIndex();
	readonly #callbacks: WhatsAppClientCallbacks;
	#socket?: WASocket;
	#status: ConnectionStatus = "off";
	#requested = false;
	#reconnectTimer?: NodeJS.Timeout;
	#consoleFilter?: ConsoleFilter;
	#ingestQueue: Promise<void> = Promise.resolve();

	constructor(root: string, callbacks: WhatsAppClientCallbacks) {
		this.#root = root;
		this.#authDirectory = join(root, "auth");
		this.#qrPath = join(root, "pairing-qr.png");
		this.#contactsPath = join(root, "contacts.json");
		this.#index = new MessageIndex(join(root, "messages.jsonl"), this.#contacts);
		this.#callbacks = callbacks;
	}

	get index(): MessageIndex {
		return this.#index;
	}

	async start(): Promise<void> {
		if (this.#requested) return;
		this.#requested = true;
		try {
			await mkdir(this.#root, { recursive: true, mode: 0o700 });
			await chmod(this.#root, 0o700);
			await this.#index.load();
			await this.#contacts.load(this.#contactsPath);
			this.#consoleFilter ??= suppressLibsignalConsole();
			await this.#connect();
		} catch (error) {
			this.#requested = false;
			this.#consoleFilter?.restore();
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
		await this.#ingestQueue;
		await rm(this.#qrPath, { force: true });
		this.#consoleFilter?.restore();
		this.#consoleFilter = undefined;
		this.#setStatus("off");
	}

	async requestHistory(chat: string): Promise<string> {
		if (!this.#socket || this.#status !== "connected") throw new Error("WhatsApp is not connected");
		await this.#ingestQueue;
		const oldest = this.#index.historyAnchor(chat);
		await this.#socket.fetchMessageHistory(
			100,
			{
				remoteJid: oldest.chatJid,
				id: oldest.messageId,
				fromMe: oldest.fromMe,
				participant: oldest.participant,
			},
			oldest.timestamp,
		);
		return `Requested up to 100 messages before ${new Date(oldest.timestamp * 1_000).toISOString()}; delivery is asynchronous and not guaranteed. Re-run find after synchronization.`;
	}

	async downloadAudio(ref: string, destination: string): Promise<void> {
		const record = this.#index.get(ref);
		if (!record) throw new Error(`Unknown WhatsApp reference: ${ref}`);
		if (record.kind !== "audio") throw new Error(`${ref} is not an audio message`);
		if (!record.encodedMessage) throw new Error(`${ref} has no retained media descriptor`);
		if (!this.#socket || this.#status !== "connected") throw new Error("WhatsApp is not connected");
		const decoded = proto.WebMessageInfo.decode(Buffer.from(record.encodedMessage, "base64"));
		if (!decoded.key) throw new Error(`${ref} has no message key`);
		const message: WAMessage = { ...decoded, key: decoded.key };
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

	async downloadImage(ref: string): Promise<{ data: string; mimeType: string }> {
		const record = this.#index.get(ref);
		if (record?.kind !== "image" || !record.encodedMessage)
			throw new Error(`${ref} has no retained image descriptor; re-sync history`);
		if (!this.#socket || this.#status !== "connected") throw new Error("WhatsApp is not connected");
		const decoded = proto.WebMessageInfo.decode(Buffer.from(record.encodedMessage, "base64"));
		if (!decoded.key) throw new Error(`${ref} has no message key`);
		const mimeType = normalizeMessageContent(decoded.message)?.imageMessage?.mimetype ?? "image/jpeg";
		if (!["image/jpeg", "image/png", "image/webp"].includes(mimeType))
			throw new Error("Unsupported image format");
		const stream = await downloadMediaMessage(
			{ ...decoded, key: decoded.key },
			"stream",
			{},
			{ logger, reuploadRequest: this.#socket.updateMediaMessage },
		);
		const chunks: Buffer[] = [];
		let size = 0;
		try {
			for await (const chunk of stream) {
				const buffer = Buffer.from(chunk);
				size += buffer.length;
				if (size > 8 * 1024 * 1024) throw new Error("Image exceeds 8 MiB limit");
				chunks.push(buffer);
			}
		} finally {
			stream.destroy();
		}
		return { data: Buffer.concat(chunks).toString("base64"), mimeType };
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
		socket.ev.on("creds.update", () => {
			if (socket !== this.#socket || !this.#requested) return;
			void saveCreds().catch((error: unknown) =>
				this.#callbacks.onError(
					`WhatsApp credentials could not be saved: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		});
		const enqueue = (operation: () => Promise<void>) => {
			if (socket !== this.#socket || !this.#requested) return;
			this.#ingestQueue = this.#ingestQueue.then(operation).catch((error: unknown) => {
				this.#callbacks.onError(
					`WhatsApp indexing failed: ${error instanceof Error ? error.message : String(error)}`,
				);
			});
		};
		const contacts = async (updates: ContactIdentity[]) => {
			this.#contacts.update(updates);
			await this.#contacts.persist(this.#contactsPath);
		};
		socket.ev.on("messages.upsert", ({ messages }) => enqueue(() => this.#ingest(messages)));
		socket.ev.on("messaging-history.set", (history) =>
			enqueue(async () => {
				await contacts([
					...history.contacts,
					...(history.lidPnMappings ?? []).map(({ lid, pn }) => ({ id: lid, lid, phoneNumber: pn })),
				]);
				await this.#ingest(history.messages);
			}),
		);
		socket.ev.on("contacts.upsert", (updates) => enqueue(() => contacts(updates)));
		socket.ev.on("contacts.update", (updates) =>
			enqueue(() => contacts(updates.filter((contact): contact is ContactIdentity => Boolean(contact.id)))),
		);
		socket.ev.on("lid-mapping.update", ({ lid, pn }) =>
			enqueue(() => contacts([{ id: lid, lid, phoneNumber: pn }])),
		);
		socket.ev.on("connection.update", (update) => {
			void this.#handleConnectionUpdate(socket, update).catch((error: unknown) =>
				this.#callbacks.onError(
					`WhatsApp connection update failed: ${error instanceof Error ? error.message : String(error)}`,
				),
			);
		});
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
