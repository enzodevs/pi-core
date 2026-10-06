import { parentPort, workerData } from "node:worker_threads";
import { WhatsAppClient } from "./client.js";
import type { MessageQuery } from "./store.js";

if (!parentPort) throw new Error("WhatsApp worker requires a parent port");
const port = parentPort;
const client = new WhatsAppClient(workerData.root, {
	onConnection: (value) => port.postMessage({ event: "connection", value }),
	onQr: (value) => port.postMessage({ event: "qr", value }),
	onError: (value) => port.postMessage({ event: "error", value }),
	onTerminalDisconnect: () => port.postMessage({ event: "terminal" }),
});

// Serialize commands, especially shutdown, without capturing detached library failures.
// Uncaught failures terminate this worker; the parent handles its error/exit events.
let queue = Promise.resolve();
port.on("message", (request: { id: number; method: string; args: unknown[] }) => {
	queue = queue.then(async () => {
		try {
			let value: unknown;
			switch (request.method) {
				case "start":
					await client.start();
					break;
				case "stop":
					await client.stop();
					break;
				case "find":
					value = client.index.find(request.args[0] as MessageQuery);
					break;
				case "count":
					value = client.index.count();
					break;
				case "history":
					value = await client.requestHistory(request.args[0] as string);
					break;
				case "image":
					value = await client.downloadImage(request.args[0] as string);
					break;
				case "audio":
					await client.downloadAudio(request.args[0] as string, request.args[1] as string);
					break;
				default:
					throw new Error("Unknown WhatsApp worker command");
			}
			port.postMessage({ id: request.id, value, count: client.index.count() });
		} catch (error) {
			port.postMessage({ id: request.id, error: error instanceof Error ? error.message : String(error) });
		}
	});
});
