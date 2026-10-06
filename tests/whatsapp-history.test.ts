import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({
	handlers: new Map<string, (event: unknown) => unknown>(),
	fetchMessageHistory: vi.fn(async () => "request-id"),
}));
vi.mock("@whiskeysockets/baileys", async (original) => ({
	...(await original<typeof import("@whiskeysockets/baileys")>()),
	useMultiFileAuthState: async () => ({ state: { creds: { registered: true } }, saveCreds: async () => {} }),
	default: () => ({
		ev: { on: (name: string, handler: (event: unknown) => unknown) => fake.handlers.set(name, handler) },
		fetchMessageHistory: fake.fetchMessageHistory,
		end: () => {},
	}),
}));

import { WhatsAppClient } from "../extensions/whatsapp/client.js";
import { messageReference } from "../extensions/whatsapp/store.js";

let client: WhatsAppClient | undefined;
afterEach(async () => {
	await client?.stop();
	client = undefined;
	fake.handlers.clear();
	vi.clearAllMocks();
});

describe("WhatsApp on-demand history", () => {
	it("requests older history with the oldest selected chat key and timestamp", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-wpp-history-"));
		let connected!: () => void;
		const ready = new Promise<void>((resolve) => {
			connected = resolve;
		});
		client = new WhatsAppClient(root, {
			onConnection: (status) => {
				if (status === "connected") connected();
			},
			onQr: () => {},
			onError: () => {},
			onTerminalDisconnect: () => {},
		});
		await client.start();
		fake.handlers.get("connection.update")?.({ connection: "open" });
		await ready;
		await client.index.add(
			[100, 200].map((timestamp) => ({
				ref: messageReference("12345@lid", String(timestamp)),
				messageId: String(timestamp),
				chatJid: "12345@lid",
				timestamp,
				fromMe: false,
				kind: "text",
			})),
		);
		expect(await client.requestHistory("12345@lid")).toContain("delivery is asynchronous");
		expect(fake.fetchMessageHistory).toHaveBeenCalledWith(
			100,
			{
				remoteJid: "12345@lid",
				id: "100",
				fromMe: false,
				participant: undefined,
			},
			100,
		);
		await expect(client.requestHistory("missing")).rejects.toThrow("exactly one");
		expect(fake.fetchMessageHistory).toHaveBeenCalledTimes(1);
	});

	it("does not attempt history requests while disconnected", async () => {
		client = new WhatsAppClient(await mkdtemp(join(tmpdir(), "pi-wpp-history-")), {
			onConnection: () => {},
			onQr: () => {},
			onError: () => {},
			onTerminalDisconnect: () => {},
		});
		await expect(client.requestHistory("12345@lid")).rejects.toThrow("not connected");
		expect(fake.fetchMessageHistory).not.toHaveBeenCalled();
	});
});
