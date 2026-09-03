import type { IndexedSkill } from "./types.js";

function terms(value: string): string[] {
	return value
		.toLowerCase()
		.split(/[^a-z0-9]+/)
		.filter(Boolean);
}

/** Bounded Levenshtein distance; exits once a row cannot meet the limit. */
function editDistanceWithin(left: string, right: string, limit: number): number | undefined {
	if (Math.abs(left.length - right.length) > limit) return undefined;
	let previous = Array.from({ length: right.length + 1 }, (_, index) => index);
	for (let leftIndex = 1; leftIndex <= left.length; leftIndex++) {
		const current = [leftIndex];
		let rowMinimum = leftIndex;
		for (let rightIndex = 1; rightIndex <= right.length; rightIndex++) {
			const value = Math.min(
				(previous[rightIndex] ?? 0) + 1,
				(current[rightIndex - 1] ?? 0) + 1,
				(previous[rightIndex - 1] ?? 0) + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
			);
			current[rightIndex] = value;
			rowMinimum = Math.min(rowMinimum, value);
		}
		if (rowMinimum > limit) return undefined;
		previous = current;
	}
	const distance = previous[right.length];
	return distance !== undefined && distance <= limit ? distance : undefined;
}

function fuzzyLimit(term: string): number {
	if (term.length >= 8) return 2;
	if (term.length >= 4) return 1;
	return 0;
}

function tokenScore(queryTerm: string, candidate: string, name: boolean): number {
	if (candidate === queryTerm) return name ? 120 : 30;
	if (candidate.startsWith(queryTerm)) return name ? 70 : 16;
	if (candidate.includes(queryTerm)) return name ? 45 : 10;
	const limit = fuzzyLimit(queryTerm);
	if (limit === 0) return 0;
	const distance = editDistanceWithin(queryTerm, candidate, limit);
	if (distance === undefined) return 0;
	return (name ? 35 : 7) - distance * (name ? 8 : 2);
}

export function searchSkills(skills: readonly IndexedSkill[], query: string, limit = 8): IndexedSkill[] {
	const normalizedQuery = query.trim().toLowerCase();
	const queryTerms = terms(normalizedQuery);
	if (queryTerms.length === 0) return [];

	return skills
		.filter((skill) => skill.mode !== "off")
		.map((skill) => {
			const normalizedName = skill.name.toLowerCase();
			const nameTerms = terms(skill.name);
			const descriptionTerms = terms(skill.description);
			let score =
				normalizedName === normalizedQuery ? 1_000 : normalizedName.includes(normalizedQuery) ? 150 : 0;
			let matchedTerms = 0;

			for (const queryTerm of queryTerms) {
				const nameScore = Math.max(
					0,
					...nameTerms.map((candidate) => tokenScore(queryTerm, candidate, true)),
				);
				const descriptionScore = Math.max(
					0,
					...descriptionTerms.map((candidate) => tokenScore(queryTerm, candidate, false)),
				);
				const best = Math.max(nameScore, descriptionScore);
				if (best > 0) {
					matchedTerms++;
					score += best;
				}
			}

			// Prefer a skill that explains the whole request over one with a single strong hit.
			if (matchedTerms === queryTerms.length) score += 80 + matchedTerms * 10;
			else score += matchedTerms * 4;
			return { skill, score, matchedTerms };
		})
		.filter(({ matchedTerms }) => matchedTerms > 0)
		.sort(
			(a, b) =>
				b.score - a.score || b.matchedTerms - a.matchedTerms || a.skill.name.localeCompare(b.skill.name),
		)
		.slice(0, Math.max(1, Math.min(limit, 20)))
		.map(({ skill }) => skill);
}
