import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillMode } from "./types.js";

function escapeXml(value: string): string {
	return value
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&apos;");
}

export function renderManagedSkills(skills: readonly Skill[], modeFor: (name: string) => SkillMode): string {
	const visible = skills.filter((skill) => {
		const mode = modeFor(skill.name);
		return !skill.disableModelInvocation && (mode === "full" || mode === "name");
	});
	if (visible.length === 0) return "";
	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		"Read a listed SKILL.md when its description matches the task. Use search_skills to discover relevant skills and load_skill to load one by exact name.",
		"When a skill references a relative path, resolve it against the skill directory.",
		"",
		"<available_skills>",
	];
	for (const skill of visible) {
		const mode = modeFor(skill.name);
		lines.push("  <skill>", `    <name>${escapeXml(skill.name)}</name>`);
		if (mode === "full") {
			lines.push(
				`    <description>${escapeXml(skill.description)}</description>`,
				`    <location>${escapeXml(skill.filePath)}</location>`,
			);
		} else {
			lines.push("    <visibility>name-only</visibility>");
		}
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}
