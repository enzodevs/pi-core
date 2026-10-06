import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { chmod, mkdir, open, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { createInterface } from "node:readline";

const MAX_TEXT_CHARACTERS = 1_000;
const MAX_RECORDS = 50_000;
const MAX_CHAT_RECORDS = 1_000;
const MAX_INDEX_BYTES = 100 * 1024 * 1024;

export interface WhatsAppMessageRecord {
	ref: string;
	messageId: string;
	chatJid: string;
	participant?: string;
	chatJidAlt?: string;
	participantAlt?: string;
	pushName?: string;
	fromMe: boolean;
	timestamp: number;
	kind: string;
	text?: string;
	durationSeconds?: number;
	encodedMessage?: string;
	reply?: {
		ref?: string;
		participant?: string;
		kind: string;
		text?: string;
	};
}

export interface MessageQuery {
	chat: string;
	kind?: "audio" | "text" | "any";
	since?: string;
	before?: string;
	limit: number;
}

export function messageReference(chatJid: string, messageId: string): string {
	return `wa_${createHash("sha256").update(`${chatJid}\0${messageId}`).digest("hex").slice(0, 16)}`;
}

function searchableIdentity(record: WhatsAppMessageRecord, contacts: ContactIndex): string {
	const ids = [record.chatJid, record.chatJidAlt, record.participant, record.participantAlt].filter(
		(id): id is string => Boolean(id),
	);
	return [...ids, record.pushName, ...ids.flatMap((id) => contacts.identities(id))]
		.filter(Boolean)
		.join(" ")
		.normalize("NFD")
		.replaceAll(/\p{M}/gu, "")
		.toLowerCase()
		.replaceAll(/[^a-z0-9@.]+/g, "");
}

function normalizedSelector(value: string): string {
	return value
		.normalize("NFD")
		.replaceAll(/\p{M}/gu, "")
		.toLowerCase()
		.replaceAll(/[^a-z0-9@.]+/g, "");
}

export function parseSince(value: string | undefined): number | undefined {
	if (!value) return undefined;
	const parsed = Date.parse(value);
	if (!Number.isFinite(parsed)) throw new Error(`Invalid since date: ${value}`);
	return Math.floor(parsed / 1_000);
}

export interface ContactIdentity {
	id: string;
	lid?: string;
	phoneNumber?: string;
	name?: string;
	notify?: string;
}

export class ContactIndex {
	readonly #aliases = new Map<string, string[]>();

	update(contacts: ContactIdentity[]): void {
		for (const contact of contacts) {
			const ids = [contact.id, contact.lid, contact.phoneNumber].filter((id): id is string => Boolean(id));
			const values = [
				...new Set(
					[...ids, contact.name, contact.notify, ...ids.flatMap((id) => this.#aliases.get(id) ?? [])].filter(
						(value): value is string => Boolean(value),
					),
				),
			];
			for (const id of values.filter((value) => value.endsWith("@lid") || value.endsWith("@s.whatsapp.net")))
				this.#aliases.set(id, values);
		}
		while (this.#aliases.size > 20_000) {
			const oldest = this.#aliases.keys().next().value;
			if (oldest) this.#aliases.delete(oldest);
		}
	}

	identities(id: string): string[] {
		return this.#aliases.get(id) ?? [];
	}

	async load(path: string): Promise<void> {
		this.#aliases.clear();
		try {
			const entries = JSON.parse(await readFile(path, "utf8")) as Array<[string, string[]]>;
			for (const [id, values] of entries.slice(-20_000)) this.#aliases.set(id, values);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}

	async persist(path: string): Promise<void> {
		await mkdir(dirname(path), { recursive: true, mode: 0o700 });
		const temporary = `${path}.${process.pid}.tmp`;
		await writeFile(temporary, JSON.stringify([...this.#aliases]), { mode: 0o600 });
		await rename(temporary, path);
	}
}

export class MessageIndex {
	readonly #path: string;
	readonly #records = new Map<string, WhatsAppMessageRecord>();

	constructor(
		path: string,
		readonly contacts = new ContactIndex(),
	) {
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
				while (retainedBytes > MAX_INDEX_BYTES) {
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
		if (evicted || this.#overRetention() || fileSize > MAX_INDEX_BYTES) await this.compact();
	}

	async add(records: WhatsAppMessageRecord[]): Promise<number> {
		const pending = new Map<string, WhatsAppMessageRecord>();
		for (const record of records) {
			const previous = this.#records.get(record.ref);
			const merged = {
				...previous,
				...Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)),
			} as WhatsAppMessageRecord;
			if (JSON.stringify(previous) !== JSON.stringify(merged)) pending.set(record.ref, merged);
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
		if (this.#overRetention() || (await stat(this.#path)).size > MAX_INDEX_BYTES) {
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
		const before = query.before ? this.#records.get(query.before) : undefined;
		if (query.before && (!before || !searchableIdentity(before, this.contacts).includes(selector)))
			throw new Error("before must reference a retained message in the selected conversation");
		return [...this.#records.values()]
			.filter((record) => searchableIdentity(record, this.contacts).includes(selector))
			.filter((record) => since === undefined || record.timestamp >= since)
			.filter(
				(record) =>
					!before ||
					record.timestamp < before.timestamp ||
					(record.timestamp === before.timestamp && record.ref.localeCompare(before.ref) > 0),
			)
			.filter((record) => query.kind === "any" || !query.kind || record.kind === query.kind)
			.sort((left, right) => right.timestamp - left.timestamp || left.ref.localeCompare(right.ref))
			.slice(0, query.limit);
	}

	historyAnchor(chat: string): WhatsAppMessageRecord {
		const records = this.find({ chat, kind: "any", limit: MAX_RECORDS });
		const chats = new Set(records.map((record) => record.chatJid));
		if (chats.size !== 1)
			throw new Error(
				"History requires exactly one indexed chat; use its exact JID if the selector is ambiguous",
			);
		return records[records.length - 1];
	}

	#overRetention(): boolean {
		if (this.#records.size > MAX_RECORDS) return true;
		const counts = new Map<string, number>();
		for (const record of this.#records.values()) {
			const count = (counts.get(record.chatJid) ?? 0) + 1;
			if (count > MAX_CHAT_RECORDS) return true;
			counts.set(record.chatJid, count);
		}
		return false;
	}

	count(): number {
		return this.#records.size;
	}

	async compact(): Promise<void> {
		const newest = [...this.#records.values()].sort((left, right) => right.timestamp - left.timestamp);
		const retained: Array<{ line: string; record: WhatsAppMessageRecord }> = [];
		let bytes = 0;
		const counts = new Map<string, number>();
		for (const record of newest) {
			if (retained.length >= MAX_RECORDS) break;
			const count = counts.get(record.chatJid) ?? 0;
			if (count >= MAX_CHAT_RECORDS) continue;
			const line = JSON.stringify(record);
			const lineBytes = Buffer.byteLength(line) + 1;
			if (bytes + lineBytes > MAX_INDEX_BYTES) continue;
			retained.push({ line, record });
			counts.set(record.chatJid, count + 1);
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
