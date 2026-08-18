import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface FastModeState {
	version: 1;
	enabled: boolean;
}

export const DEFAULT_FAST_MODE_STATE: FastModeState = { version: 1, enabled: false };

export function parseFastModeState(value: unknown): FastModeState {
	if (!value || typeof value !== "object") return { ...DEFAULT_FAST_MODE_STATE };
	const enabled = (value as Record<string, unknown>).enabled;
	return { version: 1, enabled: typeof enabled === "boolean" ? enabled : false };
}

export async function loadFastModeState(path: string): Promise<FastModeState> {
	try {
		return parseFastModeState(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return { ...DEFAULT_FAST_MODE_STATE };
		throw new Error(`Cannot read Fast mode state at ${path}`, { cause: error });
	}
}

export async function saveFastModeState(path: string, state: FastModeState): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
	await rename(temporaryPath, path);
}

export function withPriorityServiceTier(payload: unknown): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	return { ...(payload as Record<string, unknown>), service_tier: "priority" };
}
