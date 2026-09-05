// biome-ignore lint/suspicious/noControlCharactersInRegex: matches terminal ANSI escape sequences.
const ANSI_PATTERN = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const FAILURE_PATTERN =
	/(?:\bfail(?:ed|ure|ures)?\b|\berror\b|\bfatal\b|\bpanic\b|\bexception\b|\bassertion(?:error)?\b|\bnot ok\b|^\s*[✖×]|make:\s*\*\*\*)/i;
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

// Render by source position, not by line value: repeated braces and blank lines
// carry structure. Overlapping evidence windows must not duplicate that structure.
function renderLines(selected: ReadonlyMap<number, string>): string {
	const parts: string[] = [];
	let previous = -2;
	for (const [index, line] of [...selected].sort(([a], [b]) => a - b)) {
		if (index !== previous + 1) parts.push(`[output line ${index + 1}]`);
		parts.push(line);
		previous = index;
	}
	return parts.join("\n");
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
	if (Buffer.byteLength(params.text) <= params.maxBytes) return params.text;
	const cleaned = params.text.replace(ANSI_PATTERN, "").replace(/\r\n/g, "\n");
	const originalBytes = Buffer.byteLength(cleaned);
	if (originalBytes <= params.maxBytes) return cleaned;
	if (params.maxBytes < 160) return receipt(params.isError, originalBytes, params.maxBytes);

	const lines = cleaned.split("\n");
	const marker = `[context-guard excerpt of ${lines.length} output lines (${formatBytes(originalBytes)}); gaps omitted]`;
	const available = Math.max(0, params.maxBytes - Buffer.byteLength(marker) - 2);
	const selected = new Map<number, string>();
	let selectedBytes = 0;
	const add = (index: number) => {
		if (index < 0 || index >= lines.length || selected.has(index)) return;
		let line = lines[index] ?? "";
		// Adding a line can join two windows. Account for the changed gap labels
		// without repeatedly sorting and rendering the growing excerpt.
		const overhead =
			(selected.size > 0 ? 1 : 0) +
			(selected.has(index - 1) ? 0 : Buffer.byteLength(`[output line ${index + 1}]\n`)) -
			(selected.has(index + 1) ? Buffer.byteLength(`[output line ${index + 2}]\n`) : 0);
		if (selectedBytes + Buffer.byteLength(line) + overhead > available) {
			// Never silently cut ordinary source lines. Pathological single-line
			// output may still provide a useful, explicitly labelled preview.
			if (Buffer.byteLength(line) <= available) return;
			line = `${utf8Slice(line, Math.min(512, Math.floor(available / 2)))} [line truncated]`;
		}
		const nextBytes = selectedBytes + Buffer.byteLength(line) + overhead;
		if (nextBytes > available) return;
		selected.set(index, line);
		selectedBytes = nextBytes;
	};
	const failures: number[] = [];
	const diagnostics: number[] = [];
	const relevant: number[] = [];
	const terms = params.queryTerms ?? [];
	for (let index = 0; index < lines.length; index++) {
		const line = lines[index] ?? "";
		if (params.isError || ["bash", "powershell"].includes(params.toolName)) {
			if (FAILURE_PATTERN.test(line)) {
				if (failures.length < 12) failures.push(index);
			} else if (diagnostics.length < 6 && SIGNAL_PATTERN.test(line)) diagnostics.push(index);
		}
		if (relevant.length < 6 && terms.some((term) => line.toLowerCase().includes(term))) relevant.push(index);
	}
	// Reserve evidence before surrounding context, then fill whole contiguous
	// windows. Selection is bounded even for multi-megabyte command output.
	for (const index of [...failures, ...diagnostics]) add(index);
	for (const index of relevant) add(index);
	add(0);
	for (let index = lines.length - 1; index >= Math.max(0, lines.length - 3); index--) add(index);
	for (const index of [...failures, ...diagnostics, ...relevant]) {
		for (let around = index - 2; around <= index + 2; around++) add(around);
	}
	for (let index = 1; index < Math.min(lines.length, 16); index++) add(index);
	for (let index = lines.length - 4; index >= Math.max(0, lines.length - 16); index--) add(index);
	const body = renderLines(selected);
	return body ? `${body}\n\n${marker}` : marker;
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
	artifacts: ReadonlyMap<string, string> = new Map(),
): ContextProjection<T> {
	const queryTerms = extractQueryTerms(messages);
	const toolIndexes: number[] = [];
	let lastTurn = -1;
	for (let index = 0; index < messages.length; index++) {
		const message = messages[index];
		if (isToolResult(message)) toolIndexes.push(index);
		else if (
			message &&
			typeof message === "object" &&
			"role" in message &&
			(message.role === "assistant" || message.role === "user")
		)
			lastTurn = index;
	}
	// All results since the last model/user turn are first delivery, including
	// large parallel batches. Give small results their full allowance first and
	// share the rest fairly, rather than starving the earliest completed calls.
	const pending = toolIndexes
		.filter((index) => index > lastTurn)
		.map((index) => {
			const message = messages[index] as unknown as ToolResultLike;
			const bytes = message.content.reduce(
				(sum, block) =>
					sum + (block.type === "text" && typeof block.text === "string" ? Buffer.byteLength(block.text) : 0),
				0,
			);
			return {
				index,
				desired: Math.min(bytes, toolBudget(message.toolName ?? "tool", Boolean(message.isError), config)),
			};
		})
		.sort((a, b) => a.desired - b.desired);
	const firstDelivery = new Map<number, number>();
	let available = config.totalToolBytes;
	for (let position = 0; position < pending.length; position++) {
		const item = pending[position];
		if (!item) continue;
		const allocation = Math.min(item.desired, Math.floor(available / (pending.length - position)));
		firstDelivery.set(item.index, allocation);
		available -= allocation;
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
			firstDelivery.get(index) ??
			(pending.length === 0 && rank < config.recentResults
				? toolBudget(message.toolName ?? "tool", Boolean(message.isError), config)
				: config.historicalBytes);
		const allowance = Math.min(desired, remaining);
		const artifactId = message.toolCallId ? artifacts.get(message.toolCallId) : undefined;
		const artifactReceipt =
			artifactId && bytes > allowance
				? `[artifact ${artifactId}; context_lookup: query or offset (stored line)]`
				: undefined;
		const receiptBytes = artifactReceipt ? Buffer.byteLength(artifactReceipt) : 0;
		const includeReceipt = receiptBytes <= allowance;
		const budget = Math.max(0, allowance - (includeReceipt ? receiptBytes : 0));
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
		if (includeReceipt && artifactReceipt) {
			projectedContent.push({ type: "text", text: artifactReceipt });
			projectedBytes += receiptBytes;
			remaining -= receiptBytes;
			changed = true;
		}
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
