export interface SubagentLimits {
	maxDepth: number;
	maxChildrenPerRun: number;
	globalConcurrency: number;
	taskBytes: number;
	handoffBytes: number;
	questionBytes: number;
	replyBytes: number;
}

export const DEFAULT_SUBAGENT_LIMITS: Readonly<SubagentLimits> = {
	maxDepth: 3,
	maxChildrenPerRun: 4,
	globalConcurrency: 4,
	taskBytes: 8 * 1024,
	handoffBytes: 12 * 1024,
	questionBytes: 1024,
	replyBytes: 2 * 1024,
};

const LIMIT_ENV: ReadonlyArray<{
	key: keyof SubagentLimits;
	env: string;
	min: number;
	max: number;
}> = [
	{ key: "maxDepth", env: "PI_CORE_SUBAGENT_MAX_DEPTH", min: 1, max: 8 },
	{ key: "maxChildrenPerRun", env: "PI_CORE_SUBAGENT_MAX_CHILDREN", min: 1, max: 32 },
	{ key: "globalConcurrency", env: "PI_CORE_SUBAGENT_GLOBAL_CONCURRENCY", min: 1, max: 32 },
	{ key: "taskBytes", env: "PI_CORE_SUBAGENT_TASK_BYTES", min: 256, max: 64 * 1024 },
	{ key: "handoffBytes", env: "PI_CORE_SUBAGENT_HANDOFF_BYTES", min: 1024, max: 50 * 1024 },
	{ key: "questionBytes", env: "PI_CORE_SUBAGENT_QUESTION_BYTES", min: 128, max: 4 * 1024 },
	{ key: "replyBytes", env: "PI_CORE_SUBAGENT_REPLY_BYTES", min: 128, max: 8 * 1024 },
];

function parseLimit(raw: string | undefined, fallback: number, min: number, max: number): number {
	if (raw === undefined || raw.trim() === "") return fallback;
	const parsed = Number(raw);
	if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
		throw new Error(`Invalid subagent limit ${raw}; expected an integer from ${min} to ${max}.`);
	}
	return parsed;
}

export function resolveSubagentLimits(env: NodeJS.ProcessEnv = process.env): SubagentLimits {
	const resolved = { ...DEFAULT_SUBAGENT_LIMITS };
	for (const item of LIMIT_ENV) {
		resolved[item.key] = parseLimit(env[item.env], resolved[item.key], item.min, item.max);
	}
	return resolved;
}

export function validateSubagentLimits(value: unknown): SubagentLimits | null {
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const candidate = value as Partial<Record<keyof SubagentLimits, unknown>>;
	const resolved = { ...DEFAULT_SUBAGENT_LIMITS };
	for (const item of LIMIT_ENV) {
		const raw = candidate[item.key];
		if (!Number.isSafeInteger(raw) || (raw as number) < item.min || (raw as number) > item.max) return null;
		resolved[item.key] = raw as number;
	}
	return resolved;
}

export function assertBoundedText(text: string, label: string, maxBytes: number): string {
	const value = text.trim();
	if (!value) throw new Error(`${label} is required.`);
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > maxBytes) throw new Error(`${label} is too large (${bytes} bytes; max ${maxBytes}).`);
	return value;
}

export function truncateUtf8(text: string, maxBytes: number): string {
	const bytes = Buffer.from(text);
	if (bytes.length <= maxBytes) return text;

	let marker = "";
	let prefixBytes = maxBytes;
	for (let attempt = 0; attempt < 3; attempt++) {
		const omitted = bytes.length - prefixBytes;
		marker = `\n\n[truncated: ${omitted} bytes omitted]`;
		prefixBytes = Math.max(0, maxBytes - Buffer.byteLength(marker));
	}
	const prefix = bytes.subarray(0, prefixBytes).toString("utf8").replace(/�$/u, "");
	return `${prefix}${marker}`;
}
