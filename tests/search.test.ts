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

	it("tolerates small typos in names and descriptions", () => {
		expect(searchSkills(skills, "cod reveiw").map(({ name }) => name)).toEqual(["code-review"]);
		expect(searchSkills(skills, "dependncies").map(({ name }) => name)).toEqual(["xray"]);
	});

	it("prefers coverage of the whole query", () => {
		const candidates = [
			skill("frontend", "Build web interfaces", "searchable"),
			skill("accessibility-audit", "Review frontend accessibility", "searchable"),
		];
		expect(searchSkills(candidates, "frontend accessibility")[0]?.name).toBe("accessibility-audit");
	});

	it("discovers arbitrary new skills without custom metadata", () => {
		const installedTomorrow = skill(
			"database-migrator",
			"Plan and validate PostgreSQL schema migrations",
			"searchable",
		);
		expect(searchSkills([installedTomorrow], "postgres migration").map(({ name }) => name)).toEqual([
			"database-migrator",
		]);
	});

	it("does not fuzzy-match short noisy terms", () => {
		expect(searchSkills(skills, "zy")).toEqual([]);
	});

	it("returns no results for an empty query", () => {
		expect(searchSkills(skills, "  ")).toEqual([]);
	});
});
