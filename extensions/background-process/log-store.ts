import * as fs from "node:fs";
import * as path from "node:path";
import { stripVTControlCharacters } from "node:util";

const DEFAULT_SEGMENT_BYTES = 4 * 1024 * 1024;
const DEFAULT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const PROCESS_LOG_RESULT_BYTES = 4 * 1024;

export interface ProcessLogStoreOptions {
	root: string;
	segmentBytes?: number;
	ttlMs?: number;
	now?: () => number;
}

export interface ProcessLogSearchResult {
	matches: number;
	text: string;
}

function validId(id: string): boolean {
	return /^[a-f0-9]{8}$/.test(id);
}

function utf8Head(text: string, maxBytes: number): string {
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

function utf8Tail(buffer: Buffer, maxBytes: number): string {
	const start = Math.max(0, buffer.length - maxBytes);
	return buffer.subarray(start).toString("utf8").replace(/^�/u, "");
}

function cleanLine(line: string): string {
	return [...stripVTControlCharacters(line)]
		.filter(
			(character) => character === "\t" || (character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127),
		)
		.join("");
}

function lineSnippet(line: string, terms: readonly string[], maxCharacters = 1024): string {
	const cleaned = cleanLine(line);
	if (cleaned.length <= maxCharacters) return cleaned;
	const lower = cleaned.toLowerCase();
	const positions = terms.map((term) => lower.indexOf(term)).filter((position) => position >= 0);
	const center = positions.length > 0 ? Math.min(...positions) : 0;
	const start = Math.max(0, center - Math.floor(maxCharacters / 3));
	const end = Math.min(cleaned.length, start + maxCharacters);
	return `${start > 0 ? "…" : ""}${cleaned.slice(start, end)}${end < cleaned.length ? "…" : ""}`;
}

function currentPath(root: string, id: string): string {
	return path.join(root, `${id}.log`);
}

function previousPath(root: string, id: string): string {
	return path.join(root, `${id}.1.log`);
}

function readIfRegular(file: string): Buffer {
	let descriptor: number | undefined;
	try {
		const noFollow = "O_NOFOLLOW" in fs.constants ? fs.constants.O_NOFOLLOW : 0;
		const nonBlocking = "O_NONBLOCK" in fs.constants ? fs.constants.O_NONBLOCK : 0;
		descriptor = fs.openSync(file, fs.constants.O_RDONLY | noFollow | nonBlocking);
		const stat = fs.fstatSync(descriptor);
		if (!stat.isFile()) return Buffer.alloc(0);
		const content = Buffer.alloc(stat.size);
		fs.readSync(descriptor, content, 0, stat.size, 0);
		return content;
	} catch {
		return Buffer.alloc(0);
	} finally {
		if (descriptor !== undefined) fs.closeSync(descriptor);
	}
}

export class ProcessLog {
	private descriptor: number | undefined;
	private currentBytes = 0;
	private closed = false;

	constructor(
		private readonly root: string,
		readonly id: string,
		private readonly segmentBytes: number,
		reset = true,
	) {
		if (!validId(id)) throw new Error("Invalid process log ID");
		if (reset) {
			fs.rmSync(currentPath(root, id), { force: true });
			fs.rmSync(previousPath(root, id), { force: true });
			this.descriptor = fs.openSync(currentPath(root, id), "wx", 0o600);
		} else {
			this.closed = true;
		}
	}

	append(chunk: Buffer): void {
		if (this.closed || chunk.length === 0) return;
		let offset = 0;
		while (offset < chunk.length) {
			if (this.currentBytes >= this.segmentBytes) this.rotate();
			const length = Math.min(chunk.length - offset, this.segmentBytes - this.currentBytes);
			if (this.descriptor === undefined) throw new Error("Process log is closed");
			fs.writeSync(this.descriptor, chunk, offset, length);
			this.currentBytes += length;
			offset += length;
		}
	}

	retainedBytes(): number {
		return this.buffers().reduce((total, buffer) => total + buffer.length, 0);
	}

	tail(maxBytes = PROCESS_LOG_RESULT_BYTES): string {
		return utf8Tail(Buffer.concat(this.buffers()), maxBytes).trimEnd();
	}

	search(query: string, limit = 12): ProcessLogSearchResult {
		const terms = [...new Set(query.toLowerCase().match(/[\p{L}\p{N}_.:/-]{2,}/gu) ?? [])];
		if (terms.length === 0) throw new Error("Search query requires a word or identifier.");
		const lines = Buffer.concat(this.buffers()).toString("utf8").split("\n");
		const selected = new Set<number>();
		let matches = 0;
		for (let index = 0; index < lines.length && matches < limit; index++) {
			const lower = cleanLine(lines[index] ?? "").toLowerCase();
			if (!terms.every((term) => lower.includes(term))) continue;
			matches++;
			for (let around = Math.max(0, index - 1); around <= Math.min(lines.length - 1, index + 1); around++) {
				selected.add(around);
			}
		}
		const marker = `${matches} match${matches === 1 ? "" : "es"} in process ${this.id}`;
		const rendered = [...selected]
			.sort((a, b) => a - b)
			.map((index) => `${index + 1}:${lineSnippet(lines[index] ?? "", terms)}`)
			.join("\n");
		const available = Math.max(0, PROCESS_LOG_RESULT_BYTES - Buffer.byteLength(marker) - 2);
		return { matches, text: rendered ? `${marker}\n\n${utf8Head(rendered, available)}` : marker };
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		if (this.descriptor !== undefined) fs.closeSync(this.descriptor);
		this.descriptor = undefined;
	}

	remove(): void {
		this.close();
		fs.rmSync(currentPath(this.root, this.id), { force: true });
		fs.rmSync(previousPath(this.root, this.id), { force: true });
	}

	private buffers(): Buffer[] {
		return [readIfRegular(previousPath(this.root, this.id)), readIfRegular(currentPath(this.root, this.id))];
	}

	private rotate(): void {
		if (this.descriptor !== undefined) fs.closeSync(this.descriptor);
		this.descriptor = undefined;
		fs.rmSync(previousPath(this.root, this.id), { force: true });
		try {
			fs.renameSync(currentPath(this.root, this.id), previousPath(this.root, this.id));
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		this.descriptor = fs.openSync(currentPath(this.root, this.id), "wx", 0o600);
		this.currentBytes = 0;
	}
}

export class ProcessLogStore {
	private readonly root: string;
	private readonly segmentBytes: number;
	private readonly ttlMs: number;
	private readonly now: () => number;

	constructor(options: ProcessLogStoreOptions) {
		this.root = options.root;
		this.segmentBytes = options.segmentBytes ?? DEFAULT_SEGMENT_BYTES;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.now = options.now ?? Date.now;
		fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
		fs.chmodSync(this.root, 0o700);
		this.cleanup();
	}

	create(id: string): ProcessLog {
		return new ProcessLog(this.root, id, this.segmentBytes);
	}

	open(id: string): ProcessLog | undefined {
		if (!validId(id)) return undefined;
		return readIfRegular(currentPath(this.root, id)).length > 0 ||
			readIfRegular(previousPath(this.root, id)).length > 0
			? new ProcessLog(this.root, id, this.segmentBytes, false)
			: undefined;
	}

	remove(id: string): void {
		if (!validId(id)) return;
		fs.rmSync(currentPath(this.root, id), { force: true });
		fs.rmSync(previousPath(this.root, id), { force: true });
	}

	cleanup(): void {
		let entries: string[];
		try {
			entries = fs.readdirSync(this.root);
		} catch {
			return;
		}
		for (const entry of entries) {
			if (!/^[a-f0-9]{8}(?:\.1)?\.log$/.test(entry)) continue;
			const file = path.join(this.root, entry);
			try {
				const stat = fs.lstatSync(file);
				if (stat.isSymbolicLink() || !stat.isFile() || this.now() - stat.mtimeMs > this.ttlMs) {
					fs.rmSync(file, { force: true });
				}
			} catch {
				// Concurrent cleanup or rotation won the race.
			}
		}
	}
}
