import { rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { ConnectionStatus, WhatsAppClientCallbacks } from "./client.js";
import type { MessageQuery, WhatsAppMessageRecord } from "./store.js";

const require = createRequire(import.meta.url);
const bootstrap = `
const { workerData } = require('node:worker_threads');
const { createJiti } = require(workerData.jiti);
createJiti(workerData.entry).import(workerData.entry).catch(error => {
  setImmediate(() => { throw error; });
});
`;

type Pending = { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout };

export class IsolatedWhatsAppClient {
	#worker?: Worker;
	#sequence = 0;
	#termination: Promise<unknown> = Promise.resolve();
	#indexedCount = 0;
	#pending = new Map<number, Pending>();
	#lifecycle: Promise<void> = Promise.resolve();

	constructor(
		readonly root: string,
		readonly callbacks: WhatsAppClientCallbacks,
		readonly entry = fileURLToPath(new URL("./worker.ts", import.meta.url)),
	) {}

	#serialize(operation: () => Promise<void>): Promise<void> {
		const next = this.#lifecycle.then(operation);
		this.#lifecycle = next.catch(() => {});
		return next;
	}

	start(): Promise<void> {
		return this.#serialize(() => this.#start());
	}

	stop(): Promise<void> {
		return this.#serialize(() => this.#stop());
	}

	reset(): Promise<void> {
		return this.#serialize(async () => {
			await this.#stop();
			// No old socket, retry timer, or credential writer survives termination.
			for (const name of ["auth", "messages.jsonl", "contacts.json", "pairing-qr.png"]) {
				await rm(join(this.root, name), { recursive: true, force: true });
			}
			this.#indexedCount = 0;
			await this.#start();
		});
	}

	async #start(): Promise<void> {
		await this.#termination;
		if (this.#worker) return;
		const worker = new Worker(bootstrap, {
			eval: true,
			workerData: { root: this.root, entry: this.entry, jiti: require.resolve("jiti") },
			// Keep sensitive dependency diagnostics out of the Pi terminal.
			stdout: true,
			stderr: true,
		});
		worker.stdout.resume();
		worker.stderr.resume();
		this.#worker = worker;
		worker.on("message", (message) => {
			if (this.#worker !== worker) return;
			if (typeof message.count === "number") this.#indexedCount = message.count;
			if (message.event) {
				switch (message.event) {
					case "connection":
						this.callbacks.onConnection(message.value as ConnectionStatus);
						break;
					case "qr":
						this.callbacks.onQr(message.value as string);
						break;
					case "error":
						this.callbacks.onError(message.value as string);
						break;
					case "terminal":
						this.callbacks.onTerminalDisconnect();
						break;
				}
				return;
			}
			const pending = this.#pending.get(message.id);
			if (!pending) return;
			clearTimeout(pending.timer);
			this.#pending.delete(message.id);
			if (message.error) pending.reject(new Error(message.error));
			else pending.resolve(message.value);
		});
		worker.on("error", (error) => this.#failed(worker, error));
		worker.on("exit", (code) => this.#failed(worker, new Error(`Worker exited (${code})`)));
		try {
			await this.#call("start");
		} catch (error) {
			await this.#stop();
			throw error;
		}
	}

	#failed(worker: Worker, error: Error): void {
		if (this.#worker !== worker) return;
		this.#worker = undefined;
		this.#termination = worker.terminate();
		this.#rejectPending(error);
		this.callbacks.onConnection("disconnected");
		this.callbacks.onTerminalDisconnect();
		this.callbacks.onError(
			`WhatsApp worker stopped: ${error.message.slice(0, 300)}. Pi is still running; use /wpp on to reconnect.`,
		);
	}

	#rejectPending(error: Error): void {
		for (const pending of this.#pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.#pending.clear();
	}

	async #stop(): Promise<void> {
		const worker = this.#worker;
		if (worker) {
			try {
				await this.#call("stop", [], 3_000);
			} catch {
				/* Termination below also handles stuck/crashed sockets. */
			}
			this.#worker = undefined;
			this.#rejectPending(new Error("WhatsApp stopped"));
			await worker.terminate();
		}
		await this.#termination;
		await rm(join(this.root, "pairing-qr.png"), { force: true });
		this.callbacks.onConnection("off");
	}

	#call<T>(method: string, args: unknown[] = [], timeout = 60_000): Promise<T> {
		const worker = this.#worker;
		if (!worker) return Promise.reject(new Error("WhatsApp worker is off; run /wpp on"));
		const id = ++this.#sequence;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.#pending.delete(id);
				reject(new Error(`WhatsApp ${method} timed out`));
			}, timeout);
			this.#pending.set(id, { resolve: (value) => resolve(value as T), reject, timer });
			try {
				worker.postMessage({ id, method, args });
			} catch (error) {
				clearTimeout(timer);
				this.#pending.delete(id);
				reject(error);
			}
		});
	}

	find(query: MessageQuery): Promise<WhatsAppMessageRecord[]> {
		return this.#call("find", [query]);
	}
	count(): Promise<number> {
		return this.#worker ? this.#call("count") : Promise.resolve(this.#indexedCount);
	}
	requestHistory(chat: string): Promise<string> {
		return this.#call("history", [chat]);
	}
	downloadAudio(ref: string, path: string): Promise<void> {
		return this.#call("audio", [ref, path]);
	}
	downloadImage(ref: string): Promise<{ data: string; mimeType: string }> {
		return this.#call("image", [ref]);
	}
}
