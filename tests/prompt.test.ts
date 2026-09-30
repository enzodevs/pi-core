import type { Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderManagedSkills } from "../extensions/skill-manager/prompt.js";
import type { SkillMode } from "../extensions/skill-manager/types.js";

const makeSkill = (name: string, description = `${name} description`): Skill =>
	({
		name,
		description,
		filePath: `/skills/${name}/SKILL.md`,
		baseDir: `/skills/${name}`,
		disableModelInvocation: false,
		sourceInfo: {},
	}) as Skill;

describe("managed skill prompt", () => {
	it("renders full metadata, only a name for name mode, and nothing for hidden modes", () => {
		const modes: Record<string, SkillMode> = {
			full: "full",
			minimal: "name",
			searchable: "searchable",
			off: "off",
		};
		const section = renderManagedSkills(
			Object.keys(modes).map((name) => makeSkill(name)),
			(name) => modes[name] ?? "off",
		);
		expect(section).toContain("search_skills");
		expect(section).toContain("load_skill");
		expect(section).not.toContain("skill_catalog");
		expect(section).toContain("full description");
		expect(section).toContain("/skills/full/SKILL.md");
		expect(section).toContain("<name>minimal</name>");
		expect(section).not.toContain("minimal description");
		expect(section).not.toContain("searchable description");
		expect(section).not.toContain("<name>off</name>");
	});

	it("omits the section when no skills are model-visible", () => {
		expect(renderManagedSkills([makeSkill("hidden")], () => "searchable")).toBe("");
		expect(renderManagedSkills([makeSkill("disabled")], () => "off")).toBe("");
	});

	it("escapes skill metadata", () => {
		const section = renderManagedSkills([makeSkill("safe", "A < B & C")], () => "full");
		expect(section).toContain("A &lt; B &amp; C");
	});
});
