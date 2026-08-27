// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal ANSI escape sequences.
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SIGNAL_PATTERN =
	/(?:\berror\b|\bfailed?\b|\bfailure\b|\bfatal\b|\bpanic\b|\bexception\b|\bwarning\b|\bnot ok\b|\btests?\b.*\b(?:passed|failed)\b|\btest files?\b|\bexit(?:ed)?\s+(?:code\s+)?[1-9]\d*\b|make:\s*\*\*\*|\b(?:passed|failed)\s+\d+\b|\b\w+\.[cm]?[jt]sx?:\d+(?::\d+)?\b)/i;
const WORD_PATTERN = /[\p{L}\p{N}_.:/-]{3,}/gu;
const STOP_WORDS = new Set([
	"about",
	"after",
	"again",
	"before",
	"could",
	"from",
	"have",
	"into",
	"just",
	"more",
	"only",
	"should",
	"that",
	"their",
	"then",
	"there",
	"these",
	"they",
	"this",
	"through",
	"tool",
	"using",
	"want",
	"what",
	"when",
	"where",
	"which",
	"with",
	"would",
]);

export interface ContextGuardConfig {
	totalToolBytes: number;
	recentResults: number;
	bashBytes: number;
	readBytes: number;
	searchBytes: number;
	defaultBytes: number;
	errorBytes: number;
	historicalBytes: number;
}

export const DEFAULT_CONTEXT_GUARD_CONFIG: Readonly<ContextGuardConfig> = {
	totalToolBytes: 24 * 1024,
	recentResults: 4,
	bashBytes: 6 * 1024,
	readBytes: 12 * 1024,
	searchBytes: 6 * 1024,
	defaultBytes: 8 * 1024,
	errorBytes: 10 * 1024,
	historicalBytes: 1200,
};

interface TextBlock {
	type: "text";
	text: string;
	[key: string]: unknown;
}

interface ContentBlock {
	type: string;
	text?: string;
	[key: string]: unknown;
}

interface ToolResultLike {
	role: "toolResult";
	toolName?: string;
	toolCallId?: string;
	content: ContentBlock[];
	isError?: boolean;
	[key: string]: unknown;
}

interface UserLike {
	role: "user";
	content: string | ContentBlock[];
	[key: string]: unknown;
}

export interface ContextProjectionStats {
	toolResults: number;
	compressedResults: number;
	originalBytes: number;
	projectedBytes: number;
}

export interface ContextProjection<T> {
	messages: T[];
	stats: ContextProjectionStats;
}

function utf8Slice(text: string, maxBytes: number, tail = false): string {
	if (maxBytes <= 0) return "";
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;
	const selected = tail ? bytes.subarray(bytes.length - maxBytes) : bytes.subarray(0, maxBytes);
	let value = selected.toString("utf8");
	if (tail) value = value.replace(/^�/u, "");
	else value = value.replace(/�$/u, "");
	return value;
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function cleanLine(line: string): string {
	return utf8Slice(line.replace(ANSI_PATTERN, "").replace(/[ \t]+$/g, ""), 512);
}

function uniqueLines(lines: string[]): string[] {
	const seen = new Set<string>();
	const result: string[] = [];
	for (const line of lines) {
		const cleaned = cleanLine(line);
		if (!cleaned || seen.has(cleaned)) continue;
		seen.add(cleaned);
		result.push(cleaned);
	}
	return result;
}

export function extractQueryTerms(messages: readonly unknown[]): string[] {
	for (let index = messages.length - 1; index >= 0; index--) {
		const candidate = messages[index] as Partial<UserLike> | undefined;
		if (candidate?.role !== "user") continue;
		const text =
			typeof candidate.content === "string"
				? candidate.content
				: Array.isArray(candidate.content)
					? candidate.content
							.filter((block): block is TextBlock => block?.type === "text" && typeof block.text === "string")
							.map((block) => block.text)
							.join("\n")
					: "";
		const terms = (text.toLowerCase().match(WORD_PATTERN) ?? [])
			.filter((word) => !STOP_WORDS.has(word))
			.slice(-32);
		return [...new Set(terms)];
	}
	return [];
}

function relevantLines(lines: string[], terms: readonly string[]): string[] {
	if (terms.length === 0) return [];
	const selected: string[] = [];
	for (let index = 0; index < lines.length && selected.length < 18; index++) {
		const lower = lines[index]?.toLowerCase() ?? "";
		if (!terms.some((term) => lower.includes(term))) continue;
		for (let around = Math.max(0, index - 1); around <= Math.min(lines.length - 1, index + 1); around++) {
			selected.push(lines[around] ?? "");
		}
	}
	return uniqueLines(selected);
}

function diagnosticLines(lines: string[]): string[] {
	const selected: string[] = [];
	for (let index = 0; index < lines.length && selected.length < 36; index++) {
		if (!SIGNAL_PATTERN.test(lines[index] ?? "")) continue;
		for (let around = Math.max(0, index - 1); around <= Math.min(lines.length - 1, index + 1); around++) {
			selected.push(lines[around] ?? "");
		}
	}
	return uniqueLines(selected);
}

function section(title: string, lines: string[], maxBytes: number, tail = false): string {
	if (lines.length === 0 || maxBytes <= title.length + 4) return "";
	const body = utf8Slice(lines.join("\n"), Math.max(0, maxBytes - Buffer.byteLength(title) - 2), tail);
	return body ? `${title}\n${body}` : "";
}

function receipt(isError: boolean, originalBytes: number, maxBytes: number): string {
	if (maxBytes <= 0) return "";
	const value = `${isError ? "error" : "ok"} [context-guard omitted ${formatBytes(originalBytes)} of older tool output]`;
	return utf8Slice(value, maxBytes);
}

export function compressToolOutput(params: {
	toolName: string;
	text: string;
	isError: boolean;
	maxBytes: number;
	queryTerms?: readonly string[];
}): string {
	const cleaned = params.text.replace(ANSI_PATTERN, "").replace(/\r\n/g, "\n");
	const originalBytes = Buffer.byteLength(cleaned);
	if (originalBytes <= params.maxBytes) return cleaned;
	if (params.maxBytes < 160) return receipt(params.isError, originalBytes, params.maxBytes);

	const lines = cleaned.split("\n");
	const head = uniqueLines(lines.slice(0, 8));
	const diagnostics = diagnosticLines(lines);
	const relevant = relevantLines(lines, params.queryTerms ?? []);
	const tail = uniqueLines(lines.slice(-16));
	const marker = `[context-guard kept strategic slices from ${formatBytes(originalBytes)}; omitted ${formatBytes(
		Math.max(0, originalBytes - params.maxBytes),
	)}]`;
	const markerBytes = Buffer.byteLength(marker) + 2;
	const available = Math.max(0, params.maxBytes - markerBytes);
	const candidates = [
		{ title: "[start]", lines: head, weight: 1, tail: false },
		{
			title: "[diagnostics]",
			lines: diagnostics,
			weight: params.toolName === "bash" || params.isError ? 4 : 2,
			tail: false,
		},
		{ title: "[task-relevant]", lines: relevant, weight: 3, tail: false },
		{ title: "[end]", lines: tail, weight: 2, tail: true },
	].filter((candidate) => candidate.lines.length > 0);
	const totalWeight = candidates.reduce((sum, candidate) => sum + candidate.weight, 0);
	const parts = [
		...candidates.map((candidate) =>
			section(
				candidate.title,
				candidate.lines,
				Math.floor((available * candidate.weight) / totalWeight),
				candidate.tail,
			),
		),
		marker,
	].filter(Boolean);
	const projected = parts.join("\n\n");
	return Buffer.byteLength(projected) <= params.maxBytes ? projected : utf8Slice(projected, params.maxBytes);
}

function isToolResult(message: unknown): message is ToolResultLike {
	if (!message || typeof message !== "object" || Array.isArray(message)) return false;
	const candidate = message as Partial<ToolResultLike>;
	return candidate.role === "toolResult" && Array.isArray(candidate.content);
}

function toolBudget(toolName: string, isError: boolean, config: ContextGuardConfig): number {
	if (isError) return config.errorBytes;
	if (toolName === "bash" || toolName === "powershell") return config.bashBytes;
	if (toolName === "read") return config.readBytes;
	if (["grep", "find", "ls"].includes(toolName)) return config.searchBytes;
	return config.defaultBytes;
}

export function projectToolContext<T>(
	messages: readonly T[],
	config: ContextGuardConfig = DEFAULT_CONTEXT_GUARD_CONFIG,
): ContextProjection<T> {
	const queryTerms = extractQueryTerms(messages);
	const toolIndexes: number[] = [];
	for (let index = 0; index < messages.length; index++) {
		if (isToolResult(messages[index])) toolIndexes.push(index);
	}

	let remaining = config.totalToolBytes;
	let compressedResults = 0;
	let originalBytes = 0;
	let projectedBytes = 0;
	const replacements = new Map<number, T>();

	for (let rank = 0; rank < toolIndexes.length; rank++) {
		const index = toolIndexes[toolIndexes.length - 1 - rank] as number;
		const message = messages[index] as unknown as ToolResultLike;
		const textBlocks = message.content.filter(
			(block): block is TextBlock => block.type === "text" && typeof block.text === "string",
		);
		const bytes = textBlocks.reduce((sum, block) => sum + Buffer.byteLength(block.text), 0);
		originalBytes += bytes;
		const desired =
			rank < config.recentResults
				? toolBudget(message.toolName ?? "tool", Boolean(message.isError), config)
				: config.historicalBytes;
		const budget = Math.min(desired, remaining);
		let blockBudgetRemaining = budget;
		let sourceBytesRemaining = bytes;
		let changed = false;
		const projectedContent = message.content.map((block) => {
			if (block.type !== "text" || typeof block.text !== "string") return block;
			const blockBytes = Buffer.byteLength(block.text);
			const allocation =
				sourceBytesRemaining === blockBytes
					? blockBudgetRemaining
					: Math.floor((blockBudgetRemaining * blockBytes) / Math.max(1, sourceBytesRemaining));
			const compressed = compressToolOutput({
				toolName: message.toolName ?? "tool",
				text: block.text,
				isError: Boolean(message.isError),
				maxBytes: allocation,
				queryTerms,
			});
			const compressedBytes = Buffer.byteLength(compressed);
			projectedBytes += compressedBytes;
			blockBudgetRemaining = Math.max(0, blockBudgetRemaining - compressedBytes);
			sourceBytesRemaining = Math.max(0, sourceBytesRemaining - blockBytes);
			if (compressed !== block.text) changed = true;
			return compressed === block.text ? block : { ...block, text: compressed };
		});
		remaining = Math.max(0, remaining - (budget - blockBudgetRemaining));
		if (changed) {
			compressedResults++;
			replacements.set(index, { ...message, content: projectedContent } as unknown as T);
		}
	}

	return {
		messages: messages.map((message, index) => replacements.get(index) ?? message),
		stats: { toolResults: toolIndexes.length, compressedResults, originalBytes, projectedBytes },
	};
}
