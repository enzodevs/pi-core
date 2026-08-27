import { createHash, randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const ARTIFACT_VERSION = 1;
export const ARTIFACT_THRESHOLD_BYTES = 8 * 1024;
const MAX_ARTIFACT_BYTES = 8 * 1024 * 1024;
const MAX_STORE_BYTES = 128 * 1024 * 1024;
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
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options: ArtifactStoreOptions) {
		this.root = options.root;
		this.maxArtifactBytes = options.maxArtifactBytes ?? MAX_ARTIFACT_BYTES;
		this.maxStoreBytes = options.maxStoreBytes ?? MAX_STORE_BYTES;
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

	search(id: string, sessionId: string, query: string, limit = 12): ArtifactSearchResult | undefined {
		const artifact = this.get(id, sessionId);
		if (!artifact) return undefined;
		const stored = readArtifact(artifact.path, true);
		if (!stored || stored.metadata.sessionId !== sessionId) return undefined;
		const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_.:/-]{2,}/gu) ?? [])];
		if (terms.length === 0) throw new Error("Search query requires a word or identifier.");
		const lines = (stored.content ?? "").split("\n");
		const selected = new Set<number>();
		let matches = 0;
		for (let index = 0; index < lines.length && matches < limit; index++) {
			const lower = lines[index]?.toLowerCase() ?? "";
			if (!terms.every((term) => lower.includes(term))) continue;
			matches++;
			for (let around = Math.max(0, index - 1); around <= Math.min(lines.length - 1, index + 1); around++) {
				selected.add(around);
			}
		}
		const rendered = [...selected]
			.sort((a, b) => a - b)
			.map((index) => `${index + 1}:${lineSnippet(lines[index] ?? "", terms)}`)
			.join("\n");
		const marker =
			matches === 0
				? `0 matches in ${id}`
				: `${matches} match${matches === 1 ? "" : "es"} in ${id}${artifact.metadata.truncated ? " (stored prefix is truncated)" : ""}`;
		const available = Math.max(0, LOOKUP_MAX_BYTES - Buffer.byteLength(marker) - 2);
		return {
			artifact: artifact.metadata,
			matches,
			text: rendered ? `${marker}\n\n${utf8Head(rendered, available)}` : marker,
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
		for (const item of metadata) {
			const expired = now - item.createdAt > this.ttlMs;
			const exceedsBudget = retainedBytes + item.storedBytes > this.maxStoreBytes;
			if (expired || exceedsBudget) fs.rmSync(artifactPath(this.root, item.id), { force: true });
			else retainedBytes += item.storedBytes;
		}
	}
}
