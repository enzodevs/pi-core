import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const endpoint = "https://chatgpt.com/backend-api/codex/images/generations";
const pngSignature = Buffer.from("89504e470d0a1a0a", "hex");
const loginHint = "A Codex CLI ChatGPT login using file credential storage is required. Run `codex login`.";

async function subscriptionHeaders(home: string) {
	try {
		const auth = JSON.parse(await readFile(join(home, "auth.json"), "utf8"));
		const token = auth?.tokens?.access_token;
		const account = auth?.tokens?.account_id;
		if (
			auth?.auth_mode !== "chatgpt" ||
			typeof token !== "string" ||
			!token ||
			typeof account !== "string" ||
			!account
		)
			throw new Error();
		return {
			authorization: `Bearer ${token}`,
			"ChatGPT-Account-ID": account,
			"content-type": "application/json",
			originator: "pi-core",
		};
	} catch {
		throw new Error(loginHint);
	}
}

async function readPng(response: Response) {
	if (!response.body) throw new Error("Codex returned an empty response.");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	for await (const chunk of response.body) {
		bytes += chunk.byteLength;
		if (bytes > 48 * 1024 * 1024) throw new Error("Codex image response exceeds 48 MiB.");
		chunks.push(chunk);
	}
	try {
		const encoded = JSON.parse(Buffer.concat(chunks).toString("utf8"))?.data?.[0]?.b64_json;
		if (typeof encoded === "string") {
			const png = Buffer.from(encoded, "base64");
			if (png.subarray(0, 8).equals(pngSignature)) return png;
		}
	} catch {
		/* Never include provider payloads in errors. */
	}
	throw new Error("Codex did not return a PNG.");
}

export async function generateImage(prompt: string, home: string, directory: string, signal?: AbortSignal) {
	if (!prompt.trim() || prompt.length > 16000)
		throw new Error("Expected an image prompt of 1–16000 characters.");
	const headers = await subscriptionHeaders(home);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const timeout = AbortSignal.timeout(300_000);
	const response = await fetch(endpoint, {
		method: "POST",
		headers,
		redirect: "error",
		signal: signal ? AbortSignal.any([timeout, signal]) : timeout,
		body: JSON.stringify({
			model: "gpt-image-2",
			prompt,
			quality: "auto",
			size: "auto",
			background: "auto",
		}),
	});
	if (!response.ok) {
		await response.body?.cancel();
		throw new Error(
			`Codex image generation failed (HTTP ${response.status}).${response.status === 401 ? " Renew your ChatGPT login with `codex login`." : ""}`,
		);
	}
	const image = await readPng(response);
	const path = join(directory, `${randomUUID()}.png`);
	const temp = `${path}.partial`;
	try {
		await writeFile(temp, image, { flag: "wx", mode: 0o600 });
		await rename(temp, path);
	} finally {
		await rm(temp, { force: true });
	}
	return path;
}
