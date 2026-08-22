import { basename } from "node:path";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export interface AtFileQuery {
	prefix: string;
	query: string;
	quoted: boolean;
}

export function extractAtFileQuery(textBeforeCursor: string): AtFileQuery | undefined {
	const match = textBeforeCursor.match(/(?:^|[ \t])(@(?:"[^"]*|[^\s]*))$/);
	const prefix = match?.[1];
	if (!prefix) return undefined;
	const quoted = prefix.startsWith('@"');
	return {
		prefix,
		query: quoted ? prefix.slice(2) : prefix.slice(1),
		quoted,
	};
}

function fuzzyScore(value: string, query: string): number {
	let queryIndex = 0;
	let firstMatch = -1;
	let lastMatch = -1;
	let consecutive = 0;
	for (let index = 0; index < value.length && queryIndex < query.length; index += 1) {
		if (value[index] !== query[queryIndex]) continue;
		if (firstMatch === -1) firstMatch = index;
		if (lastMatch === index - 1) consecutive += 1;
		lastMatch = index;
		queryIndex += 1;
	}
	if (queryIndex !== query.length) return 0;
	return 2_000 + consecutive * 20 - (lastMatch - firstMatch) * 2 - firstMatch;
}

interface SearchableFile {
	filePath: string;
	name: string;
	lowerPath: string;
	lowerName: string;
}

interface ScoredFile extends SearchableFile {
	score: number;
}

const searchCache = new WeakMap<readonly string[], SearchableFile[]>();

function searchableFiles(files: readonly string[]): SearchableFile[] {
	const cached = searchCache.get(files);
	if (cached) return cached;
	const prepared = files.map((filePath) => {
		const name = basename(filePath);
		return { filePath, name, lowerPath: filePath.toLowerCase(), lowerName: name.toLowerCase() };
	});
	searchCache.set(files, prepared);
	return prepared;
}

function scorePath(file: SearchableFile, needle: string): number {
	if (!needle) return 1_000 - Math.min(file.filePath.length, 999);
	if (file.lowerName === needle) return 10_000;
	if (file.lowerName.startsWith(needle)) return 8_000 - file.lowerName.length;
	if (file.lowerName.includes(needle)) return 6_000 - file.lowerName.indexOf(needle);
	if (file.lowerPath.startsWith(needle)) return 5_000 - file.lowerPath.length;
	if (file.lowerPath.includes(needle)) return 4_000 - file.lowerPath.indexOf(needle);
	const nameScore = fuzzyScore(file.lowerName, needle);
	const pathScore = fuzzyScore(file.lowerPath, needle);
	return Math.max(nameScore > 0 ? nameScore + 500 : 0, pathScore);
}

function compareFiles(left: ScoredFile, right: ScoredFile): number {
	return right.score - left.score || left.filePath.localeCompare(right.filePath);
}

function insertTopFile(top: ScoredFile[], candidate: ScoredFile, limit: number): void {
	if (limit <= 0 || (top.length === limit && compareFiles(candidate, top[top.length - 1]) >= 0)) return;
	let low = 0;
	let high = top.length;
	while (low < high) {
		const middle = (low + high) >>> 1;
		if (compareFiles(candidate, top[middle]) < 0) high = middle;
		else low = middle + 1;
	}
	top.splice(low, 0, candidate);
	if (top.length > limit) top.pop();
}

function completionValue(filePath: string, quoted: boolean): string {
	if (quoted || filePath.includes(" ")) return `@"${filePath}"`;
	return `@${filePath}`;
}

export function rankFiles(files: readonly string[], query: AtFileQuery, limit = 20): AutocompleteItem[] {
	const needle = query.query.toLowerCase();
	const top: ScoredFile[] = [];
	for (const file of searchableFiles(files)) {
		const score = scorePath(file, needle);
		if (score > 0) insertTopFile(top, { ...file, score }, limit);
	}
	return top.map(({ filePath, name }) => ({
		value: completionValue(filePath, query.quoted),
		label: name,
		description: filePath,
	}));
}
