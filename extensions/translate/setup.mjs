import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";

const directory = join(homedir(), ".pi", "agent", "pi-core", "translate");
const filename = "translategemma-4b-it-Q6_K.gguf";
const destination = join(directory, filename);
const digest = "b8d7be5aa1720e95a5d59a50282efa01cfbd4efca94f6f224bd2ad4a0c68beb0";
const url = `https://huggingface.co/bullerwins/translategemma-4b-it-GGUF/resolve/7c938465a870d8624bcfa98a8e4a3510053c19a8/${filename}`;

async function checksum(path) {
	const hash = createHash("sha256");
	for await (const chunk of createReadStream(path)) hash.update(chunk);
	return hash.digest("hex");
}

await mkdir(directory, { recursive: true, mode: 0o700 });
if ((await checksum(destination).catch(() => "")) === digest) {
	console.log(`Verified existing TranslateGemma Q6 model: ${destination}`);
} else {
	console.log("Downloading TranslateGemma 4B Q6 (3.2 GB). Model terms: https://ai.google.dev/gemma/terms");
	const temporary = `${destination}.${process.pid}.partial`;
	try {
		const response = await fetch(url, { signal: AbortSignal.timeout(20 * 60 * 1000) });
		if (!response.ok || !response.body) throw new Error(`Model download failed: HTTP ${response.status}`);
		const hash = createHash("sha256");
		const verify = new Transform({
			transform(chunk, _encoding, done) {
				hash.update(chunk);
				done(null, chunk);
			},
		});
		await pipeline(
			Readable.fromWeb(response.body),
			verify,
			createWriteStream(temporary, { flags: "wx", mode: 0o600 }),
		);
		if (hash.digest("hex") !== digest) throw new Error("Model checksum mismatch; download not installed.");
		await rename(temporary, destination);
		console.log(`Installed verified model: ${destination}`);
	} finally {
		await rm(temporary, { force: true });
	}
}
await chmod(destination, 0o600);
console.log("Requires llama-server on PATH (or PI_TRANSLATE_LLAMA_SERVER). Reload Pi, then /translate on.");
