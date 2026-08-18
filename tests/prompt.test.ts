import type { Skill } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { renderManagedSkills, replaceSkillsSection } from "../extensions/skill-manager/prompt.js";
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
		expect(section).toContain("full description");
		expect(section).toContain("/skills/full/SKILL.md");
		expect(section).toContain("<name>minimal</name>");
		expect(section).not.toContain("minimal description");
		expect(section).not.toContain("searchable description");
		expect(section).not.toContain("<name>off</name>");
	});

	it("replaces Pi's original skill block without duplicating it", () => {
		const original = [
			"Header",
			"",
			"The following skills provide specialized instructions for specific tasks.",
			"old guidance",
			"<available_skills>",
			"old skill",
			"</available_skills>",
			"Current working directory: /work",
		].join("\n");
		const result = replaceSkillsSection(original, "\n\nMANAGED");
		expect(result).toBe("Header\n\nMANAGED\nCurrent working directory: /work");
	});

	it("escapes skill metadata", () => {
		const section = renderManagedSkills([makeSkill("safe", "A < B & C")], () => "full");
		expect(section).toContain("A &lt; B &amp; C");
	});
});
