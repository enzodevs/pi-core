import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ARTIFACT_VERSION = 1;
// Capture results that can later exceed the historical projection allowance.
export const ARTIFACT_THRESHOLD_BYTES = 1200;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_STORE_BYTES = 128 * 1024 * 1024;
const MAX_ARTIFACTS = 512;
const ARTIFACT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const METADATA_HEADER_MAX_BYTES = 16 * 1024;
const STALE_TEMPORARY_MS = 60 * 60 * 1000;
export const LOOKUP_MAX_BYTES = 4 * 1024;

export interface ArtifactMetadata {
	version: 1;
	id: string;
	toolCallId: string;
	toolName: string;
	sessionId: string;
	createdAt: number;
	originalBytes: number;
	storedBytes: number;
	truncated: boolean;
}

export interface ArtifactStoreOptions {
	root: string;
	maxArtifactBytes?: number;
	maxStoreBytes?: number;
	maxArtifacts?: number;
	ttlMs?: number;
	now?: () => number;
}

export interface StoredArtifact {
	metadata: ArtifactMetadata;
	path: string;
}

export interface ArtifactSearchResult {
	artifact: ArtifactMetadata;
	matches: number;
	text: string;
}

function atomicWrite(file: string, content: string): void {
	const temporary = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
	fs.writeFileSync(temporary, content, { encoding: "utf8", mode: 0o600 });
	fs.renameSync(temporary, file);
}

function artifactPath(root: string, id: string): string {
	return path.join(root, `${id}.artifact`);
}

function validId(id: string): boolean {
	return /^[a-f0-9]{16}$/.test(id);
}

function parseMetadata(value: string): ArtifactMetadata | undefined {
	try {
		const parsed = JSON.parse(value) as Partial<ArtifactMetadata>;
		return parsed.version === ARTIFACT_VERSION &&
			validId(parsed.id ?? "") &&
			typeof parsed.toolCallId === "string" &&
			typeof parsed.toolName === "string" &&
			typeof parsed.sessionId === "string" &&
			typeof parsed.createdAt === "number" &&
			typeof parsed.originalBytes === "number" &&
			typeof parsed.storedBytes === "number" &&
			typeof parsed.truncated === "boolean"
			? (parsed as ArtifactMetadata)
			: undefined;
	} catch {
		return undefined;
	}
}

function openRegularNoFollow(file: string): number | undefined {
	let descriptor: number | undefined;
	try {
		const noFollow = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
		const nonBlocking = "O_NONBLOCK" in fs.constants ? fs.constants.O_NONBLOCK : 0;
		descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlocking);
		if (!fs.fstatSync(descriptor).isFile()) {
			fs.closeSync(descriptor);
			return undefined;
		}
		return descriptor;
	} catch {
		if (descriptor !== undefined) fs.closeSync(descriptor);
		return undefined;
	}
}

function readArtifact(
	file: string,
	includeContent: boolean,
): { metadata: ArtifactMetadata; content?: string } | undefined {
	const descriptor = openRegularNoFollow(file);
	if (descriptor === undefined) return undefined;
	try {
		const stat = fs.fstatSync(descriptor);
		const headerLength = Math.min(stat.size, METADATA_HEADER_MAX_BYTES);
		const header = Buffer.alloc(headerLength);
		fs.readSync(descriptor, header, 0, headerLength, 0);
		const newline = header.indexOf(0x0a);
		if (newline < 0) return undefined;
		const metadata = parseMetadata(header.subarray(0, newline).toString("utf8"));
		if (!metadata) return undefined;
		if (!includeContent) return { metadata };
		const contentLength = stat.size - newline - 1;
		if (contentLength < 0 || contentLength > metadata.storedBytes) return undefined;
		const content = Buffer.alloc(contentLength);
		fs.readSync(descriptor, content, 0, contentLength, newline + 1);
		return { metadata, content: content.toString("utf8") };
	} finally {
		fs.closeSync(descriptor);
	}
}

function utf8Head(value: Buffer | string, maxBytes: number): string {
	const text = typeof value === "string" ? value : value.toString("utf8");
	if (Buffer.byteLength(text) <= maxBytes) return text;
	let low = 0;
	let high = text.length;
	while (low < high) {
		const middle = Math.ceil((low + high) / 2);
		if (Buffer.byteLength(text.slice(0, middle)) <= maxBytes) low = middle;
		else high = middle - 1;
	}
	let result = text.slice(0, low);
	if (/^[\uD800-\uDBFF]$/u.test(result.at(-1) ?? "")) result = result.slice(0, -1);
	return result;
}

function lineSnippet(line: string, terms: readonly string[], maxCharacters = 1024): string {
	if (line.length <= maxCharacters) return line;
	const lower = line.toLowerCase();
	const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
	const center = positions.length > 0 ? Math.min(...positions) : 0;
	const start = Math.max(0, center - Math.floor(maxCharacters / 3));
	const end = Math.min(line.length, start + maxCharacters);
	return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
}

function readPiBashOutput(
	candidate: string,
	maxBytes: number,
): { buffer: Buffer; originalBytes: number } | undefined {
	const resolved = path.resolve(candidate);
	let temporaryRoot: string;
	try {
		temporaryRoot = fs.realpathSync(os.tmpdir());
	} catch {
		return undefined;
	}
	const basename = path.basename(resolved);
	if (!/^pi-bash-[a-f0-9]{16}\.log$/.test(basename)) return undefined;
	try {
		if (fs.realpathSync(path.dirname(resolved)) !== temporaryRoot) return undefined;
	} catch {
		return undefined;
	}
	const descriptor = openRegularNoFollow(path.join(temporaryRoot, basename));
	if (descriptor === undefined) return undefined;
	try {
		const stat = fs.fstatSync(descriptor);
		const length = Math.min(stat.size, maxBytes);
		const buffer = Buffer.alloc(length);
		fs.readSync(descriptor, buffer, 0, length, 0);
		return { buffer, originalBytes: stat.size };
	} finally {
		fs.closeSync(descriptor);
	}
}

export class ArtifactStore {
	private readonly root: string;
	private readonly maxArtifactBytes: number;
	private readonly maxStoreBytes: number;
	private readonly maxArtifacts: number;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options: ArtifactStoreOptions) {
		this.root = options.root;
		this.maxArtifactBytes = options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
		this.maxStoreBytes = options.maxStoreBytes ?? MAX_STORE_BYTES;
		this.maxArtifacts = options.maxArtifacts ?? MAX_ARTIFACTS;
		this.ttlMs = options.ttlMs ?? ARTIFACT_TTL_MS;
		this.now = options.now ?? Date.now;
		fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
		fs.chmodSync(this.root, 0o700);
		this.cleanup();
	}

	store(params: {
		toolCallId: string;
		toolName: string;
		sessionId: string;
		content: string;
		fullOutputPath?: string;
	}): StoredArtifact | undefined {
		let source: Buffer | string = params.content;
		let originalBytes = Buffer.byteLength(params.content);
		let usedFullOutput = false;
		if (params.toolName === "bash" && params.fullOutputPath) {
			const fullOutput = readPiBashOutput(params.fullOutputPath, this.maxArtifactBytes);
			if (fullOutput) {
				source = fullOutput.buffer;
				originalBytes = fullOutput.originalBytes;
				usedFullOutput = true;
			}
		}
		if (originalBytes < ARTIFACT_THRESHOLD_BYTES && !usedFullOutput) return undefined;

		const decodedBytes = Buffer.byteLength(typeof source === "string" ? source : source.toString("utf8"));
		const content = utf8Head(source, this.maxArtifactBytes);
		const storedBytes = Buffer.byteLength(content);
		const id = createHash("sha256")
			.update(params.sessionId)
			.update("\0")
			.update(params.toolCallId)
			.update("\0")
			.update(content)
			.digest("hex")
			.slice(0, 16);
		const metadata: ArtifactMetadata = {
			version: ARTIFACT_VERSION,
			id,
			toolCallId: params.toolCallId,
			toolName: params.toolName,
			sessionId: params.sessionId,
			createdAt: this.now(),
			originalBytes,
			storedBytes,
			truncated:
				originalBytes > (typeof source === "string" ? Buffer.byteLength(source) : source.length) ||
				decodedBytes > storedBytes,
		};
		const file = artifactPath(this.root, id);
		atomicWrite(file, `${JSON.stringify(metadata)}\n${content}`);
		this.cleanup();
		return this.get(id, params.sessionId);
	}

	get(id: string, sessionId: string): StoredArtifact | undefined {
		if (!validId(id)) return undefined;
		const file = artifactPath(this.root, id);
		const artifact = readArtifact(file, false);
		if (!artifact || artifact.metadata.sessionId !== sessionId) return undefined;
		if (this.now() - artifact.metadata.createdAt > this.ttlMs) {
			fs.rmSync(file, { force: true });
			return undefined;
		}
		return { metadata: artifact.metadata, path: file };
	}

	readRange(id: string, sessionId: string, offset = 1, limit = 40): ArtifactSearchResult | undefined {
		if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("Offset must be a positive integer.");
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 80)
			throw new Error("Limit must be between 1 and 80.");
		const artifact = this.get(id, sessionId);
		if (!artifact) return undefined;
		const stored = readArtifact(artifact.path, true);
		if (!stored || stored.metadata.sessionId !== sessionId) return undefined;
		const lines = (stored.content ?? "").split("\n");
		const selected: string[] = [];
		let bytes = 0;
		let index = offset - 1;
		let clipped = false;
		// Leave a fixed allowance for bounded metadata, never cut the final result
		// mid-line without telling the caller.
		const budget = LOOKUP_MAX_BYTES - 256;
		for (; index < lines.length && selected.length < limit; index++) {
			const line = `${index + 1}:${lines[index] ?? ""}`;
			const size = Buffer.byteLength(line) + 1;
			if (bytes + size > budget) {
				if (selected.length === 0) {
					selected.push(`${utf8Head(line, budget - 32)} [line truncated]`);
					clipped = true;
					index++;
				}
				break;
			}
			selected.push(line);
			bytes += size;
		}
		const status = artifact.metadata.truncated ? "; stored prefix truncated" : "; complete stored output";
		const next = index < lines.length ? `; next offset=${index + 1}` : "; end of stored output";
		const clip = clipped ? "; use query to search within the clipped line" : "";
		return {
			artifact: artifact.metadata,
			matches: selected.length,
			text: `${id}: ${selected.length} lines from ${offset} of ${lines.length}${status}${next}${clip}\n${selected.join("\n")}`,
		};
	}

	search(id: string, sessionId: string, query: string, limit = 12): ArtifactSearchResult | undefined {
		if (!Number.isSafeInteger(limit) || limit < 1 || limit > 80)
			throw new Error("Limit must be between 1 and 80.");
		if (query.length > 256) throw new Error("Query must be at most 256 characters.");
		const artifact = this.get(id, sessionId);
		if (!artifact) return undefined;
		const stored = readArtifact(artifact.path, true);
		if (!stored || stored.metadata.sessionId !== sessionId) return undefined;
		const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_.:/-]{2,}/gu) ?? [])];
		if (terms.length === 0) throw new Error("Search query requires a word or identifier.");
		const lines = (stored.content ?? "").split("\n");
		const phrase = query.trim().toLowerCase();
		const ranked: { index: number; score: number }[] = [];
		let matches = 0;
		for (let index = 0; index < lines.length; index++) {
			const lower = (lines[index] ?? "").toLowerCase();
			const count = terms.reduce((sum, term) => sum + Number(lower.includes(term)), 0);
			if (count === 0) continue;
			matches++;
			const score = count * 2 + Number(lower.includes(phrase));
			// Keep only the bounded best candidates; repeated matches must not
			// allocate and sort an object for every line of an 8 MiB artifact.
			if (ranked.length === limit && score <= (ranked[ranked.length - 1]?.score ?? 0)) continue;
			const position = ranked.findIndex((candidate) => score > candidate.score);
			if (position < 0) ranked.push({ index, score });
			else ranked.splice(position, 0, { index, score });
			if (ranked.length > limit) ranked.pop();
		}
		const selected = new Map<number, string>();
		let bytes = 0;
		const add = (index: number) => {
			if (index < 0 || index >= lines.length || selected.has(index)) return;
			const line = `${index + 1}:${lineSnippet(lines[index] ?? "", terms)}`;
			const size = Buffer.byteLength(line) + 1;
			if (bytes + size > LOOKUP_MAX_BYTES - 256) return;
			selected.set(index, line);
			bytes += size;
		};
		// Spend the byte budget on the best hits first, not the earliest lines in
		// the file. Add surrounding evidence only after the hits have an allowance.
		for (const candidate of ranked) add(candidate.index);
		for (const candidate of ranked) {
			if (!selected.has(candidate.index)) continue;
			// Return a useful evidence window in this call, not just the location
			// of a hit that forces another read. Overlapping windows merge by index.
			for (let distance = 1; distance <= 8; distance++) {
				add(candidate.index - distance);
				add(candidate.index + distance);
			}
		}
		const shown = [...selected.keys()].filter((index) =>
			terms.some((term) => (lines[index] ?? "").toLowerCase().includes(term)),
		).length;
		const rendered = [...selected]
			.sort(([a], [b]) => a - b)
			.map(([, line]) => line)
			.join("\n");
		const searchNote = terms.length > 1 ? "; ranked; partial term matches included" : "";
		const truncationNote = artifact.metadata.truncated ? "; stored prefix is truncated" : "";
		const marker = `${matches} matches in ${id}; showing ${shown}${searchNote}${truncationNote}; offset reads surrounding lines`;
		return {
			artifact: artifact.metadata,
			matches,
			text: rendered ? `${marker}\n\n${rendered}` : marker,
		};
	}

	cleanup(): void {
		const now = this.now();
		let entries: string[];
		try {
			entries = fs.readdirSync(this.root);
		} catch {
			return;
		}
		for (const entry of entries) {
			const file = path.join(this.root, entry);
			if (entry.endsWith(".json") || entry.endsWith(".txt")) {
				fs.rmSync(file, { force: true });
				continue;
			}
			if (!entry.endsWith(".tmp")) continue;
			try {
				if (now - fs.lstatSync(file).mtimeMs > STALE_TEMPORARY_MS) fs.rmSync(file, { force: true });
			} catch {
				// A concurrent writer may have committed it.
			}
		}
		const metadata = entries
			.filter((entry) => entry.endsWith(".artifact"))
			.flatMap((entry) => {
				const file = path.join(this.root, entry);
				const value = readArtifact(file, false);
				if (!value || entry !== `${value.metadata.id}.artifact`) {
					fs.rmSync(file, { force: true });
					return [];
				}
				return [value.metadata];
			})
			.sort((a, b) => b.createdAt - a.createdAt);
		let retainedBytes = 0;
		let retainedCount = 0;
		for (const item of metadata) {
			const expired = now - item.createdAt > this.ttlMs;
			const exceedsBudget =
				retainedBytes + item.storedBytes > this.maxStoreBytes || retainedCount >= this.maxArtifacts;
			if (expired || exceedsBudget) fs.rmSync(artifactPath(this.root, item.id), { force: true });
			else {
				retainedBytes += item.storedBytes;
				retainedCount++;
			}
		}
	}
}
