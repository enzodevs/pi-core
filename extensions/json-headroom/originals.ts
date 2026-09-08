import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

// Never evict evidence referenced by a session. Stop compacting when the
// best-effort shared budget is full; concurrent Pi processes may overshoot it.
const MAX_FILES = 256;
const MAX_BYTES = 32 * 1024 * 1024;

export interface OriginalReference {
	path: string;
	discard: () => Promise<void>;
}

export async function saveOriginal(directory: string, text: string): Promise<OriginalReference> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const entries = (await readdir(directory)).filter((name) => name.endsWith(".json"));
	if (entries.length >= MAX_FILES) throw new Error("JSON original store is full");
	let bytes = Buffer.byteLength(text);
	for (const name of entries) {
		bytes += (await stat(join(directory, name))).size;
		if (bytes > MAX_BYTES) throw new Error("JSON original store is full");
	}
	const hash = createHash("sha256").update(text).digest("hex");
	// Each result owns its file: rollback must never delete another session's reference.
	const destination = join(directory, `${hash}-${randomUUID()}.json`);
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, text, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, destination);
		return { path: destination, discard: () => rm(destination, { force: true }) };
	} finally {
		await rm(temporary, { force: true });
	}
}
