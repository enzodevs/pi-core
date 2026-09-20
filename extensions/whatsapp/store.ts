import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const MAX_TEXT_CHARACTERS = 1_000;
const MAX_RECORDS = 50_000;
const MAX_INDEX_BYTES = 100 * 1024 * 1024;

export interface WhatsAppMessageRecord {
	ref: string;
	messageId: string;
	chatJid: string;
	participant?: string;
	pushName?: string;
	fromMe: boolean;
	timestamp: number;
	kind: string;
	text?: string;
	durationSeconds?: number;
	encodedMessage?: string;
}

export interface MessageQuery {
	chat: string;
	kind?: "audio" | "text" | "any";
	since?: string;
	limit: number;
}

export function messageReference(chatJid: string, messageId: string): string {
	return `wa_${createHash("sha256").update(`${chatJid}\0${messageId}`).digest("hex").slice(0, 16)}`;
}

function searchableIdentity(record: WhatsAppMessageRecord): string {
	return [record.chatJid, record.participant, record.pushName]
		.filter(Boolean)
		.join(" ")
		.toLowerCase()
		.replaceAll(/[^a-z0-9@.]+/g, "");
}

function normalizedSelector(value: string): string {
	return value.toLowerCase().replaceAll(/[^a-z0-9@.]+/g, "");
}

export function parseSince(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid since date: ${value}`);
	return Math.floor(parsed / 1_000);
}

export class MessageIndex {
	readonly #path: string;
	readonly #records = new Map<string, WhatsAppMessageRecord>();

	constructor(path: string) {
		this.#path = path;
	}

	async load(): Promise<void> {
		this.#records.clear();
		let fileSize: number;
		try {
			fileSize = (await stat(this.#path)).size;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
		const lineBytes = new Map<string, number>();
		let retainedBytes = 0;
		let evicted = false;
		const lines = createInterface({
			input: createReadStream(this.#path, { encoding: "utf8" }),
			crlfDelay: Number.POSITIVE_INFINITY,
		});
		for await (const line of lines) {
			if (!line) continue;
			try {
				const record = JSON.parse(line) as WhatsAppMessageRecord;
				if (!record.ref || !record.chatJid || !record.messageId) continue;
				const bytes = Buffer.byteLength(line) + 1;
				retainedBytes -= lineBytes.get(record.ref) ?? 0;
				this.#records.delete(record.ref);
				this.#records.set(record.ref, record);
				lineBytes.set(record.ref, bytes);
				retainedBytes += bytes;
				while (this.#records.size > MAX_RECORDS || retainedBytes > MAX_INDEX_BYTES) {
					const oldest = this.#records.keys().next().value;
					if (!oldest) break;
					evicted = true;
					this.#records.delete(oldest);
					retainedBytes -= lineBytes.get(oldest) ?? 0;
					lineBytes.delete(oldest);
				}
			} catch {
				// An interrupted final append must not make the rest of the private index unreadable.
			}
		}
		if (evicted || fileSize > MAX_INDEX_BYTES) await this.compact();
	}

	async add(records: WhatsAppMessageRecord[]): Promise<number> {
		const pending = new Map<string, WhatsAppMessageRecord>();
		for (const record of records) {
			if (!this.#records.has(record.ref)) pending.set(record.ref, record);
		}
		const fresh = [...pending.values()];
		if (!fresh.length) return 0;
		await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
		const file = await open(this.#path, "a", 0o600);
		try {
			await file.writeFile(`${fresh.map((record) => JSON.stringify(record)).join("\n")}\n`);
		} finally {
			await file.close();
		}
		await chmod(this.#path, 0o600);
		for (const record of fresh) this.#records.set(record.ref, record);
		if (this.#records.size > MAX_RECORDS || (await stat(this.#path)).size > MAX_INDEX_BYTES) {
			await this.compact();
		}
		return fresh.length;
	}

	get(ref: string): WhatsAppMessageRecord | undefined {
		return this.#records.get(ref);
	}

	find(query: MessageQuery): WhatsAppMessageRecord[] {
		const selector = normalizedSelector(query.chat);
		if (selector.length < 3) throw new Error("chat must contain at least 3 letters or digits");
		const since = parseSince(query.since);
		return [...this.#records.values()]
			.filter((record) => searchableIdentity(record).includes(selector))
			.filter((record) => !since || record.timestamp >= since)
			.filter((record) => query.kind === "any" || !query.kind || record.kind === query.kind)
			.sort((left, right) => right.timestamp - left.timestamp)
			.slice(0, query.limit);
	}

	count(): number {
		return this.#records.size;
	}

	async compact(): Promise<void> {
		const newest = [...this.#records.values()]
			.sort((left, right) => right.timestamp - left.timestamp)
			.slice(0, MAX_RECORDS);
		const retained: Array<{ line: string; record: WhatsAppMessageRecord }> = [];
		let bytes = 0;
		for (const record of newest) {
			const line = JSON.stringify(record);
			const lineBytes = Buffer.byteLength(line) + 1;
			if (bytes + lineBytes > MAX_INDEX_BYTES) continue;
			retained.push({ line, record });
			bytes += lineBytes;
		}
		retained.reverse();
		this.#records.clear();
		for (const { record } of retained) this.#records.set(record.ref, record);
		const temporary = `${this.#path}.${process.pid}.${Date.now()}.tmp`;
		await writeFile(temporary, `${retained.map(({ line }) => line).join("\n")}\n`, { mode: 0o600 });
		await rename(temporary, this.#path);
	}
}

export function truncateMessageText(text: string | undefined): string | undefined {
	if (!text) return undefined;
	return text.length <= MAX_TEXT_CHARACTERS ? text : `${text.slice(0, MAX_TEXT_CHARACTERS)}…`;
}
