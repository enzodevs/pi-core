import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { IsolatedWhatsAppClient } from "../extensions/whatsapp/isolated-client.js";

const clients: IsolatedWhatsAppClient[] = [];
afterEach(async () => {
	await Promise.all(clients.splice(0).map((client) => client.stop()));
});

async function fixture(source: string) {
	const root = await mkdtemp(join(tmpdir(), "pi-wpp-worker-"));
	const entry = join(root, "fake-worker.mjs");
	await writeFile(entry, `import { parentPort, workerData } from 'node:worker_threads';\n${source}`);
	const errors: string[] = [];
	const states: string[] = [];
	const client = new IsolatedWhatsAppClient(
		root,
		{
			onConnection: (value) => states.push(value),
			onQr: () => {},
			onError: (value) => errors.push(value),
			onTerminalDisconnect: () => {},
		},
		entry,
	);
	clients.push(client);
	return { client, root, errors, states };
}

describe("WhatsApp worker isolation", () => {
	it("contains a detached Connection Closed rejection and rejects the pending call", async () => {
		const { client, errors, states } = await fixture(`
			parentPort.on('message', ({id, method}) => {
				if (method === 'history') { setImmediate(() => { Promise.reject(new Error('Connection Closed')); }); return; }
				parentPort.postMessage({id, value: undefined});
			});
		`);
		await client.start();
		await expect(client.requestHistory("test")).rejects.toThrow("Connection Closed");
		expect(errors.join()).toContain("Pi is still running");
		expect(states).toContain("disconnected");
		await client.start();
		await client.stop();
		expect(states.at(-1)).toBe("off");
	});

	it("survives a crash during reset, removes only local pairing/history, then starts a new worker", async () => {
		const { client, root } = await fixture(`
			import { existsSync, appendFileSync } from 'node:fs';
			import { join } from 'node:path';
			parentPort.on('message', ({id, method}) => {
				if (method === 'stop') { setImmediate(() => { throw new Error('Connection Closed'); }); return; }
				if (method === 'start') appendFileSync(join(workerData.root, 'starts.txt'), String(existsSync(join(workerData.root, 'auth'))) + '\\n');
				parentPort.postMessage({id, value: undefined});
			});
		`);
		await mkdir(join(root, "auth"));
		await writeFile(join(root, "auth", "test.json"), "{}");
		await writeFile(join(root, "messages.jsonl"), "old");
		await writeFile(join(root, "contacts.json"), "old");
		await client.start();
		await client.reset();
		expect(await readFile(join(root, "starts.txt"), "utf8")).toBe("true\nfalse\n");
		await expect(readFile(join(root, "messages.jsonl"))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(readFile(join(root, "contacts.json"))).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("loads the packaged real TypeScript worker without opening a socket", async () => {
		// The default worker is imported via jiti; count/stop do not connect to WhatsApp.
		const { Worker } = await import("node:worker_threads");
		const { createRequire } = await import("node:module");
		const { fileURLToPath } = await import("node:url");
		const root = await mkdtemp(join(tmpdir(), "pi-wpp-worker-load-"));
		const worker = new Worker(
			`
			const {workerData}=require('node:worker_threads');
			require(workerData.jiti).createJiti(workerData.entry).import(workerData.entry).catch(e=>{setImmediate(()=>{throw e})});
		`,
			{
				eval: true,
				workerData: {
					root,
					jiti: createRequire(import.meta.url).resolve("jiti"),
					entry: fileURLToPath(new URL("../extensions/whatsapp/worker.ts", import.meta.url)),
				},
			},
		);
		try {
			const result = new Promise<unknown>((resolve, reject) => {
				worker.once("message", resolve);
				worker.once("error", reject);
			});
			worker.postMessage({ id: 1, method: "count", args: [] });
			expect(await result).toMatchObject({ id: 1, value: 0 });
		} finally {
			await worker.terminate();
		}
	}, 15_000);
});
