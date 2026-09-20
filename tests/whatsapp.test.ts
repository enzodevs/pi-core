import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { proto } from "@whiskeysockets/baileys";
import { describe, expect, it } from "vitest";
import { messageToRecord } from "../extensions/whatsapp/client.js";
import { suppressLibsignalConsole } from "../extensions/whatsapp/libsignal-console.js";
import { MessageIndex, messageReference, parseSince } from "../extensions/whatsapp/store.js";
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

	it("rejects broad selectors and invalid dates", () => {
		const index = new MessageIndex("unused");
		expect(() => index.find({ chat: "12", limit: 10 })).toThrow("at least 3");
		expect(() => parseSince("not-a-date")).toThrow("Invalid since date");
	});
});

describe("WhatsApp message normalization", () => {
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
