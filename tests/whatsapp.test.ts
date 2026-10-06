import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { messageToRecord } from "../extensions/whatsapp/client.js";
import { suppressLibsignalConsole } from "../extensions/whatsapp/libsignal-console.js";
import { ContactIndex, MessageIndex, messageReference, parseSince } from "../extensions/whatsapp/store.js";
import { boundedTranscript } from "../extensions/whatsapp/transcribe.js";

describe("WhatsApp private message index", () => {
	it("indexes, deduplicates, filters, and keeps the file private", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-wpp-"));
		const path = join(root, "messages.jsonl");
		const index = new MessageIndex(path);
		const audio = {
			ref: messageReference("55119999@s.whatsapp.net", "a1"),
			messageId: "a1",
			chatJid: "55119999@s.whatsapp.net",
			pushName: "Alice",
			fromMe: false,
			timestamp: 1_735_689_600,
			kind: "audio",
			durationSeconds: 12,
		};
		const text = {
			...audio,
			ref: messageReference(audio.chatJid, "t1"),
			messageId: "t1",
			kind: "text",
			text: "private message",
			timestamp: audio.timestamp + 1,
		};

		expect(await index.add([audio, text, audio])).toBe(2);
		expect(index.find({ chat: "9999", kind: "audio", limit: 10 })).toEqual([audio]);
		expect(index.find({ chat: "alice", kind: "text", limit: 10 })).toEqual([text]);
		expect((await stat(path)).mode & 0o777).toBe(0o600);

		const restored = new MessageIndex(path);
		await restored.load();
		expect(restored.count()).toBe(2);
		expect(await restored.add([audio])).toBe(0);
		expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(2);
	});

	it("retains the newest 1,000 by timestamp across out-of-order batches and reloads", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-wpp-"));
		const path = join(root, "messages.jsonl");
		const records = Array.from({ length: 1_200 }, (_, timestamp) => ({
			ref: messageReference("55119999@s.whatsapp.net", String(timestamp)),
			messageId: String(timestamp),
			chatJid: "55119999@s.whatsapp.net",
			fromMe: false,
			timestamp,
			kind: "text",
		}));
		const index = new MessageIndex(path);
		await index.add(records.slice(600).reverse());
		await index.add(records.slice(0, 600).reverse());
		expect(index.count()).toBe(1_000);
		expect(index.get(records[199].ref)).toBeUndefined();
		expect(index.get(records[200].ref)).toBeDefined();
		// Loading a legacy oversized index must also retain by date, not file order.
		const { writeFile } = await import("node:fs/promises");
		await writeFile(
			path,
			`${records
				.reverse()
				.map((record) => JSON.stringify(record))
				.join("\n")}\n`,
		);
		const restored = new MessageIndex(path);
		await restored.load();
		expect(restored.count()).toBe(1_000);
		expect(restored.find({ chat: "9999", kind: "any", limit: 1 })[0].timestamp).toBe(1_199);
		expect(restored.get(messageReference("55119999@s.whatsapp.net", "199"))).toBeUndefined();
		expect((await readFile(path, "utf8")).trim().split("\n")).toHaveLength(1_000);
		await writeFile(path, "");
		await restored.load();
		expect(restored.count()).toBe(0);
	});

	it("keeps quiet-chat history alongside busy chats and paginates timestamp ties", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-wpp-"));
		const index = new MessageIndex(join(root, "messages.jsonl"));
		const make = (chatJid: string, timestamp: number, messageId = String(timestamp)) => ({
			ref: messageReference(chatJid, messageId),
			messageId,
			chatJid,
			timestamp,
			fromMe: false,
			kind: "text",
		});
		await index.add([
			make("quiet@lid", 1),
			...Array.from({ length: 1_100 }, (_, i) => make("busy@lid", i + 10)),
		]);
		expect(index.count()).toBe(1_001);
		expect(index.historyAnchor("quiet@lid").timestamp).toBe(1);
		await index.add([make("quiet@lid", 2, "a"), make("quiet@lid", 2, "b")]);
		const first = index.find({ chat: "quiet@lid", kind: "any", limit: 1 });
		const second = index.find({ chat: "quiet@lid", kind: "any", before: first[0].ref, limit: 1 });
		expect(second[0].timestamp).toBe(2);
		expect(second[0].ref).not.toBe(first[0].ref);
		expect(index.find({ chat: "quiet@lid", before: second[0].ref, limit: 1 })[0].timestamp).toBe(1);
		expect(() => index.find({ chat: "busy@lid", before: first[0].ref, limit: 1 })).toThrow(
			"before must reference",
		);
		expect(() => index.historyAnchor("@lid")).toThrow("exactly one");
	});

	it("enriches replayed messages with reply metadata without duplicating them", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-wpp-"));
		const path = join(root, "messages.jsonl");
		const index = new MessageIndex(path);
		const record = {
			ref: messageReference("quiet@lid", "m"),
			messageId: "m",
			chatJid: "quiet@lid",
			timestamp: 1,
			fromMe: false,
			kind: "text",
		};
		await index.add([record]);
		await index.add([{ ...record, reply: { kind: "text", text: "supplier unavailable" } }]);
		expect(index.count()).toBe(1);
		await index.load();
		expect(index.get(record.ref)?.reply?.text).toBe("supplier unavailable");
	});

	it("rejects broad selectors and invalid dates", () => {
		const index = new MessageIndex("unused");
		expect(() => index.find({ chat: "12", limit: 10 })).toThrow("at least 3");
		expect(() => parseSince("not-a-date")).toThrow("Invalid since date");
	});
});

describe("WhatsApp contact identities", () => {
	it("resolves saved names and phone numbers for LID history before and after restart", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-wpp-contacts-"));
		const index = new MessageIndex(join(root, "messages.jsonl"));
		await index.add([
			{
				ref: messageReference("12345@lid", "a1"),
				messageId: "a1",
				chatJid: "12345@lid",
				fromMe: false,
				timestamp: 123,
				kind: "text",
			},
		]);
		index.contacts.update([{ id: "12345@lid", name: "Mateus Rossi Rossi" }]);
		index.contacts.update([
			{ id: "12345@lid", lid: "12345@lid", phoneNumber: "5518996202708@s.whatsapp.net" },
		]);
		for (const chat of ["Mateus Rossi Rossi", "+55 18 99620-2708", "996202708"]) {
			expect(index.find({ chat, kind: "any", limit: 10 })).toHaveLength(1);
		}
		const path = join(root, "contacts.json");
		await index.contacts.persist(path);
		expect((await stat(path)).mode & 0o777).toBe(0o600);
		const contacts = new ContactIndex();
		await contacts.load(path);
		const restored = new MessageIndex(join(root, "messages.jsonl"), contacts);
		await restored.load();
		expect(restored.find({ chat: "Mateus Rossi Rossi", limit: 1 })).toHaveLength(1);
		await contacts.load(join(root, "missing-contacts.json"));
		expect(restored.find({ chat: "Mateus Rossi Rossi", limit: 1 })).toHaveLength(0);
	});

	it("merges PN and LID identities regardless of event order and handles accents", () => {
		const contacts = new ContactIndex();
		contacts.update([{ id: "5519981584136@s.whatsapp.net", name: "Igão Novo" }]);
		contacts.update([{ id: "5678@lid", phoneNumber: "5519981584136@s.whatsapp.net" }]);
		contacts.update([{ id: "5678@lid", notify: "Igor" }]);
		expect(contacts.identities("5678@lid")).toContain("Igão Novo");
		expect(contacts.identities("5519981584136@s.whatsapp.net")).toContain("Igor");
	});
});

describe("WhatsApp message normalization", () => {
	it("preserves quoted text and identifies images without treating captions as plain text", () => {
		const record = messageToRecord({
			key: { remoteJid: "12345@lid", id: "reply", fromMe: false },
			messageTimestamp: 123,
			message: {
				imageMessage: {
					caption: "Replacement",
					mimetype: "image/jpeg",
					contextInfo: {
						stanzaId: "original",
						participant: "12345@lid",
						quotedMessage: { conversation: "Supplier no longer has this product" },
					},
				},
			},
		});
		expect(record).toMatchObject({
			kind: "image",
			text: "Replacement",
			reply: {
				ref: messageReference("12345@lid", "original"),
				kind: "text",
				text: "Supplier no longer has this product",
			},
		});
		expect(record?.encodedMessage).toBeTruthy();
	});

	it("preserves a quoted audio marker without inventing a transcript", () => {
		const record = messageToRecord({
			key: { remoteJid: "12345@lid", id: "reply" },
			messageTimestamp: 123,
			message: {
				extendedTextMessage: {
					text: "Correction",
					contextInfo: { stanzaId: "audio", quotedMessage: { audioMessage: { seconds: 20 } } },
				},
			},
		});
		expect(record?.reply).toMatchObject({ kind: "audio", ref: messageReference("12345@lid", "audio") });
		expect(record?.reply?.text).toBeUndefined();
	});
	it("keeps v7 alternative phone identities and ignores missing keys", () => {
		const record = messageToRecord({
			key: {
				remoteJid: "12345@lid",
				id: "alt-1",
				remoteJidAlt: "5518996202708@s.whatsapp.net",
			} as import("@whiskeysockets/baileys").WAMessageKey,
			messageTimestamp: 123,
			message: { conversation: "hello" },
		});
		expect(record?.chatJidAlt).toBe("5518996202708@s.whatsapp.net");
		expect(messageToRecord({ message: { conversation: "missing key" } })).toBeUndefined();
	});
	it("retains an opaque audio descriptor without exposing media bytes", () => {
		const message = proto.WebMessageInfo.create({
			key: { remoteJid: "55119999@s.whatsapp.net", id: "audio-1", fromMe: false },
			pushName: "Alice",
			messageTimestamp: 1_735_689_600,
			message: { audioMessage: { seconds: 42, mediaKey: new Uint8Array([1, 2, 3]) } },
		});
		const record = messageToRecord(message);
		expect(record).toMatchObject({ kind: "audio", durationSeconds: 42, pushName: "Alice" });
		expect(record?.ref).toMatch(/^wa_[a-f0-9]{16}$/);
		expect(record?.encodedMessage).toBeTruthy();
		expect(record).not.toHaveProperty("message");
	});

	it("ignores status broadcasts", () => {
		const message = proto.WebMessageInfo.create({
			key: { remoteJid: "status@broadcast", id: "status-1" },
			message: { conversation: "not for the index" },
		});
		expect(messageToRecord(message)).toBeUndefined();
	});
});

describe("WhatsApp libsignal console isolation", () => {
	it("suppresses only known noisy sensitive messages and restores the console", () => {
		const seen: unknown[][] = [];
		const fake = {
			error: (...args: unknown[]) => seen.push(args),
			warn: (...args: unknown[]) => seen.push(args),
			info: (...args: unknown[]) => seen.push(args),
		} as unknown as Console;
		const originalError = fake.error;
		const filter = suppressLibsignalConsole(fake);
		fake.error("Failed to decrypt message with any known session...");
		fake.info("Closing session:", { privateKey: "must not render" });
		fake.warn("unrelated warning");
		expect(filter.suppressed()).toBe(2);
		expect(seen).toEqual([["unrelated warning"]]);
		filter.restore();
		expect(fake.error).toBe(originalError);
	});
});

describe("WhatsApp transcript bounds", () => {
	it("normalizes whitespace and truncates oversized transcripts", () => {
		expect(boundedTranscript(" hello\n  world ")).toEqual({ text: "hello world", truncated: false });
		const result = boundedTranscript("x".repeat(13_000));
		expect(result.truncated).toBe(true);
		expect(result.text.length).toBe(12_001);
	});
});
