import type { IndexedSkill } from "./types.js";

function terms(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

export function searchSkills(skills: readonly IndexedSkill[], query: string, limit = 8): IndexedSkill[] {
	const queryTerms = terms(query);
	if (queryTerms.length === 0) return [];
	return skills
		.filter((skill) => skill.mode !== "off")
		.map((skill) => {
			const name = skill.name.toLowerCase();
			const description = skill.description.toLowerCase();
			let score = name === query.toLowerCase() ? 1000 : 0;
			for (const term of queryTerms) {
				if (name === term) score += 100;
				else if (name.includes(term)) score += 30;
				if (description.includes(term)) score += 5;
			}
			return { skill, score };
		})
		.filter(({ score }) => score > 0)
		.sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
		.slice(0, Math.max(1, Math.min(limit, 20)))
		.map(({ skill }) => skill);
}
