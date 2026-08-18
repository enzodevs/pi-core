import type { Skill } from "@earendil-works/pi-coding-agent";

export const SKILL_MODES = ["full", "name", "searchable", "off"] as const;
export type SkillMode = (typeof SKILL_MODES)[number];

export interface SkillManagerConfig {
	version: 1;
	defaultMode: SkillMode;
	profiles: Record<string, { skills: Record<string, SkillMode> }>;
}

export interface IndexedSkill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	mode: SkillMode;
}

export function toIndexedSkill(skill: Skill, mode: SkillMode): IndexedSkill {
	return {
		name: skill.name,
		description: skill.description,
		filePath: skill.filePath,
		baseDir: skill.baseDir,
		mode,
	};
}
