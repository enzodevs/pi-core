import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SKILL_MODES, type SkillManagerConfig, type SkillMode } from "./types.js";

const DEFAULT_CONFIG: SkillManagerConfig = {
	version: 1,
	defaultMode: "full",
	profiles: {},
};

function isMode(value: unknown): value is SkillMode {
	return typeof value === "string" && SKILL_MODES.includes(value as SkillMode);
}

export function parseConfig(value: unknown): SkillManagerConfig {
	if (!value || typeof value !== "object") return structuredClone(DEFAULT_CONFIG);
	const input = value as Record<string, unknown>;
	const profiles: SkillManagerConfig["profiles"] = {};
	if (input.profiles && typeof input.profiles === "object") {
		for (const [cwd, rawProfile] of Object.entries(input.profiles)) {
			if (!rawProfile || typeof rawProfile !== "object") continue;
			const rawSkills = (rawProfile as Record<string, unknown>).skills;
			if (!rawSkills || typeof rawSkills !== "object") continue;
			const skills: Record<string, SkillMode> = {};
			for (const [name, mode] of Object.entries(rawSkills)) {
				if (isMode(mode)) skills[name] = mode;
			}
			profiles[resolve(cwd)] = { skills };
		}
	}
	return {
		version: 1,
		defaultMode: isMode(input.defaultMode) ? input.defaultMode : "full",
		profiles,
	};
}

export async function loadConfig(path: string): Promise<SkillManagerConfig> {
	try {
		return parseConfig(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return structuredClone(DEFAULT_CONFIG);
		throw new Error(`Cannot read skill manager config at ${path}`, { cause: error });
	}
}

export async function saveConfig(path: string, config: SkillManagerConfig): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporaryPath = `${path}.${process.pid}.tmp`;
	await writeFile(temporaryPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await rename(temporaryPath, path);
}

export function getSkillMode(config: SkillManagerConfig, cwd: string, name: string): SkillMode {
	return config.profiles[resolve(cwd)]?.skills[name] ?? config.defaultMode;
}

export function setSkillMode(
	config: SkillManagerConfig,
	cwd: string,
	name: string,
	mode: SkillMode,
): SkillManagerConfig {
	const key = resolve(cwd);
	return {
		...config,
		profiles: {
			...config.profiles,
			[key]: {
				skills: { ...config.profiles[key]?.skills, [name]: mode },
			},
		},
	};
}
