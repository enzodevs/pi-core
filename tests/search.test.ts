import { describe, expect, it } from "vitest";
import { searchSkills } from "../extensions/skill-manager/search.js";
import type { IndexedSkill } from "../extensions/skill-manager/types.js";

const skill = (name: string, description: string, mode: IndexedSkill["mode"]): IndexedSkill => ({
	name,
	description,
	mode,
	filePath: `/skills/${name}/SKILL.md`,
	baseDir: `/skills/${name}`,
});

describe("skill search", () => {
	const skills = [
		skill("xray", "Trace source dependencies and call flow", "searchable"),
		skill("code-review", "Review changes for defects", "full"),
		skill("secret-review", "Review private security changes", "off"),
	];

	it("ranks name matches above descriptions", () => {
		expect(searchSkills(skills, "xray").map(({ name }) => name)).toEqual(["xray"]);
	});

	it("finds description terms while excluding off skills", () => {
		expect(searchSkills(skills, "review").map(({ name }) => name)).toEqual(["code-review"]);
	});

	it("returns no results for an empty query", () => {
		expect(searchSkills(skills, "  ")).toEqual([]);
	});
});
