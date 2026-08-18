import type { Skill } from "@earendil-works/pi-coding-agent";
import type { SkillMode } from "./types.js";

const SECTION_START = "\n\nThe following skills provide specialized instructions for specific tasks.";
const SECTION_END = "</available_skills>";

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
		"Full skills can be loaded with read when their descriptions match. Name-only skills must be inspected or loaded with skill_catalog before use.",
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

export function replaceSkillsSection(systemPrompt: string, managedSection: string): string {
	const start = systemPrompt.indexOf(SECTION_START);
	let prompt = systemPrompt;
	if (start >= 0) {
		const end = systemPrompt.indexOf(SECTION_END, start);
		if (end >= 0) prompt = systemPrompt.slice(0, start) + systemPrompt.slice(end + SECTION_END.length);
	}
	const cwdMarker = "\nCurrent working directory:";
	const cwdIndex = prompt.lastIndexOf(cwdMarker);
	if (cwdIndex < 0) return `${prompt}${managedSection}`;
	return prompt.slice(0, cwdIndex) + managedSection + prompt.slice(cwdIndex);
}
