import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { createServer } from "node:net";
import { join } from "node:path";
import { getStoragePaths } from "../skill-manager/paths.js";

// Exact text-only rendering of the pinned TranslateGemma chat template (pt-BR → en).
export function translationPrompt(text: string): string {
	return (
		"<bos><start_of_turn>user\n" +
		"You are a professional Portuguese (pt-BR) to English (en) translator. Your goal is to accurately convey the meaning and nuances of the original Portuguese text while adhering to English grammar, vocabulary, and cultural sensitivities.\n" +
		"Produce only the English translation, without any additional explanations or commentary. Please translate the following Portuguese text into English:\n\n\n" +
		text.trim() +
		"<end_of_turn>\n<start_of_turn>model\n"
	);
}

async function freePort(): Promise<number> {
	const server = createServer();
	return new Promise((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("Could not allocate a local translator port."));
				return;
			}
			server.close((error) => (error ? reject(error) : resolve(address.port)));
		});
	});
}

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
	if (!response.ok) throw new Error(`Local translator HTTP ${response.status}.`);
	if (!response.body) throw new Error("Local translator returned no response.");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.length;
			if (bytes > 128 * 1024) throw new Error("Local translator response exceeds 128 KiB.");
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const result: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
	if (!result || typeof result !== "object" || Array.isArray(result)) {
		throw new Error("Local translator returned invalid JSON.");
	}
	return result as Record<string, unknown>;
}

export class LocalTranslator {
	private child: ChildProcess | undefined;
	private starting: Promise<void> | undefined;
	private lifetime = new AbortController();
	private url = "";
	private key = "";

	async start(): Promise<void> {
		if (this.starting) return this.starting;
		if (this.child && !this.lifetime.signal.aborted) return;
		const lifetime = new AbortController();
		this.lifetime = lifetime;
		this.starting = this.launch(lifetime).finally(() => {
			this.starting = undefined;
		});
		try {
			await this.starting;
		} catch (error) {
			await this.stop();
			throw error;
		}
	}

	private async launch(lifetime: AbortController): Promise<void> {
		const model = join(getStoragePaths().directory, "translate", "translategemma-4b-it-Q6_K.gguf");
		await access(model).catch(() => {
			throw new Error("Translation model missing. Run make translate-install in pi-core first.");
		});
		const port = await freePort();
		lifetime.signal.throwIfAborted();
		this.url = `http://127.0.0.1:${port}`;
		this.key = randomBytes(24).toString("hex");
		const env = Object.fromEntries(
			Object.entries(process.env).filter(([name]) => !name.startsWith("LLAMA_")),
		);
		const child = spawn(
			process.env.PI_TRANSLATE_LLAMA_SERVER || "llama-server",
			[
				"--model",
				model,
				"--host",
				"127.0.0.1",
				"--port",
				String(port),
				"--ctx-size",
				"4096",
				"--parallel",
				"1",
				"--threads",
				"8",
				"--gpu-layers",
				"auto",
				"--offline",
				// /completion uses our exact raw template; disable incompatible chat parser auto-detection.
				"--no-jinja",
				"--chat-template",
				"gemma",
				"--no-webui",
				"--no-context-shift",
			],
			{ stdio: ["ignore", "pipe", "pipe"], env: { ...env, LLAMA_API_KEY: this.key } },
		);
		this.child = child;
		let tail = "";
		await new Promise<void>((resolve, reject) => {
			const timeout = setTimeout(() => reject(new Error("Local translator startup timed out.")), 120_000);
			const finish = (error?: Error) => {
				clearTimeout(timeout);
				lifetime.signal.removeEventListener("abort", abort);
				if (error) reject(error);
				else resolve();
			};
			const abort = () => finish(new Error("Local translator stopped."));
			lifetime.signal.addEventListener("abort", abort, { once: true });
			const log = (data: Buffer) => {
				tail = (tail + data.toString("utf8")).slice(-4096);
				if (tail.includes(`listening on http://127.0.0.1:${port}`)) finish();
			};
			child.stdout?.on("data", log);
			child.stderr?.on("data", log);
			child.once("error", (error) => finish(new Error(`Cannot start llama-server: ${error.message}`)));
			child.once("exit", (code) => {
				finish(new Error(`Local translator exited (${code}). ${tail.slice(-1200)}`));
				lifetime.abort();
			});
		});
		await this.request("/health", undefined, AbortSignal.timeout(5000));
	}

	private async request(
		path: string,
		body: Record<string, unknown> | undefined,
		signal?: AbortSignal,
	): Promise<Record<string, unknown>> {
		const signals = [this.lifetime.signal, AbortSignal.timeout(60_000)];
		if (signal) signals.push(signal);
		const response = await fetch(`${this.url}${path}`, {
			method: body ? "POST" : "GET",
			headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.key}` },
			body: body ? JSON.stringify(body) : undefined,
			signal: AbortSignal.any(signals),
			redirect: "error",
		});
		return boundedJson(response);
	}

	async translate(text: string, signal?: AbortSignal): Promise<string> {
		await this.start();
		const prompt = translationPrompt(text);
		const tokenized = await this.request(
			"/tokenize",
			{ content: prompt, add_special: false, parse_special: true },
			signal,
		);
		if (!Array.isArray(tokenized.tokens) || tokenized.tokens.length > 1500) {
			throw new Error("Translation chunk exceeds the model input budget. Split the prompt.");
		}
		const result = await this.request(
			"/completion",
			{
				prompt: tokenized.tokens,
				n_predict: 1800,
				temperature: 0,
				seed: 0,
				stream: false,
				cache_prompt: true,
				stop: ["<end_of_turn>", "<eos>"],
			},
			signal,
		);
		if (result.truncated === true || result.stop_type === "limit" || result.stopped_limit === true) {
			throw new Error("Translation was truncated; prompt was not sent.");
		}
		if (typeof result.content !== "string" || !result.content.trim()) {
			throw new Error("Local translator returned empty text.");
		}
		return result.content;
	}

	async stop(): Promise<void> {
		this.lifetime.abort();
		const child = this.child;
		this.child = undefined;
		if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
		await new Promise<void>((resolve) => {
			const timeout = setTimeout(() => child.kill("SIGKILL"), 2000);
			child.once("close", () => {
				clearTimeout(timeout);
				resolve();
			});
			child.kill("SIGTERM");
		});
	}
}
