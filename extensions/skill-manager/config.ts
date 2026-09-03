import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { SKILL_MODES, type SkillManagerConfig, type SkillMode, type SkillModeResolution } from "./types.js";

const DEFAULT_CONFIG: SkillManagerConfig = {
	version: 2,
	defaultMode: "full",
	globalSkills: {},
	projects: {},
};

function isMode(value: unknown): value is SkillMode {
	return typeof value === "string" && SKILL_MODES.includes(value as SkillMode);
}

function parseSkills(value: unknown): Record<string, SkillMode> {
	if (!value || typeof value !== "object") return {};
	const skills: Record<string, SkillMode> = {};
	for (const [name, mode] of Object.entries(value as Record<string, unknown>)) {
		if (isMode(mode)) skills[name] = mode;
	}
	return skills;
}

function parseProjects(value: unknown): SkillManagerConfig["projects"] {
	if (!value || typeof value !== "object") return {};
	const projects: SkillManagerConfig["projects"] = {};
	for (const [path, profile] of Object.entries(value as Record<string, unknown>)) {
		if (!profile || typeof profile !== "object") continue;
		projects[resolve(path)] = {
			skills: parseSkills((profile as Record<string, unknown>).skills),
		};
	}
	return projects;
}

export function parseConfig(value: unknown): SkillManagerConfig {
	if (!value || typeof value !== "object") return structuredClone(DEFAULT_CONFIG);
	const input = value as Record<string, unknown>;
	// Version 1 profiles were exact-CWD entries. Preserve them as project overrides;
	// they continue to work and are naturally replaced when users edit a project.
	const projects = parseProjects(input.projects ?? input.profiles);
	return {
		version: 2,
		defaultMode: isMode(input.defaultMode) ? input.defaultMode : DEFAULT_CONFIG.defaultMode,
		globalSkills: parseSkills(input.globalSkills),
		projects,
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
	const temporary = `${path}.${process.pid}.${Date.now()}.tmp`;
	await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
}

export function resolveSkillMode(
	config: SkillManagerConfig,
	project: string,
	name: string,
): SkillModeResolution {
	const projectMode = config.projects[resolve(project)]?.skills[name];
	if (projectMode) return { mode: projectMode, source: "project" };
	const globalMode = config.globalSkills[name];
	if (globalMode) return { mode: globalMode, source: "global" };
	return { mode: config.defaultMode, source: "default" };
}

export function getSkillMode(config: SkillManagerConfig, project: string, name: string): SkillMode {
	return resolveSkillMode(config, project, name).mode;
}

export function setProjectSkillMode(
	config: SkillManagerConfig,
	project: string,
	name: string,
	mode: SkillMode,
): SkillManagerConfig {
	const key = resolve(project);
	return {
		...config,
		projects: {
			...config.projects,
			[key]: { skills: { ...config.projects[key]?.skills, [name]: mode } },
		},
	};
}

export function clearProjectSkillMode(
	config: SkillManagerConfig,
	project: string,
	name: string,
): SkillManagerConfig {
	const key = resolve(project);
	const skills = { ...config.projects[key]?.skills };
	delete skills[name];
	const projects = { ...config.projects };
	if (Object.keys(skills).length === 0) delete projects[key];
	else projects[key] = { skills };
	return { ...config, projects };
}

export function setGlobalSkillMode(
	config: SkillManagerConfig,
	name: string,
	mode: SkillMode,
): SkillManagerConfig {
	return { ...config, globalSkills: { ...config.globalSkills, [name]: mode } };
}

export function clearGlobalSkillMode(config: SkillManagerConfig, name: string): SkillManagerConfig {
	const globalSkills = { ...config.globalSkills };
	delete globalSkills[name];
	return { ...config, globalSkills };
}
