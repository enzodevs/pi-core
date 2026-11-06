import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export type FastTier = "priority" | "ultrafast";
export type FastAction = "" | "on" | "off";

export interface FastModeState {
	version: 1;
	enabled: boolean;
	tier: FastTier;
}

const DEFAULT_FAST_MODE_STATE: FastModeState = { version: 1, enabled: false, tier: "priority" };

/** Models whose live OpenAI catalog entry lists the `ultrafast` service tier. */
const ULTRAFAST_MODELS = new Set(["gpt-6.1-sol", "gpt-6-astra"]);

export function parseFastModeState(value: unknown): FastModeState {
	if (!value || typeof value !== "object") return { ...DEFAULT_FAST_MODE_STATE };
	const { enabled, tier } = value as Record<string, unknown>;
	return {
		version: 1,
		enabled: typeof enabled === "boolean" ? enabled : false,
		tier: tier === "ultrafast" ? "ultrafast" : "priority",
	};
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

export function nextFastModeState(state: FastModeState, tier: FastTier, action: FastAction): FastModeState {
	const enabled = action === "on" || (action === "" && !(state.enabled && state.tier === tier));
	return { version: 1, enabled, tier };
}

/** Models without Ultrafast use Fast rather than failing or silently losing priority. */
export function resolveServiceTier(state: FastModeState, modelId: string | undefined): FastTier | undefined {
	if (!state.enabled) return undefined;
	return state.tier === "ultrafast" && modelId && ULTRAFAST_MODELS.has(modelId) ? "ultrafast" : "priority";
}

export function withServiceTier(payload: unknown, tier: FastTier): unknown {
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) return payload;
	return { ...(payload as Record<string, unknown>), service_tier: tier };
}
