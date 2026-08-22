import { execFile } from "node:child_process";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SEARCH_TIMEOUT_MS = 2_000;
const EXCLUDED_SEGMENTS = new Set([
	".cache",
	".git",
	".gradle",
	".npm",
	".next",
	".turbo",
	"__pycache__",
	"BraveSoftware",
	"Cache",
	"Caches",
	"build",
	"coverage",
	"dist",
	"google-chrome",
	"mozilla",
	"node_modules",
	"target",
	"vendor",
]);

function isUseful(filePath: string): boolean {
	return !filePath.split("/").some((segment) => EXCLUDED_SEGMENTS.has(segment));
}

function displayPath(filePath: string, useTilde: boolean): string {
	if (!useTilde) return filePath;
	const fromHome = relative(homedir(), filePath).replaceAll("\\", "/");
	return fromHome ? `~/${fromHome}` : "~/";
}

async function directEntries(absoluteQuery: string, useTilde: boolean): Promise<string[]> {
	const endsWithSlash = absoluteQuery.endsWith("/");
	const directory = endsWithSlash ? absoluteQuery : dirname(absoluteQuery);
	const prefix = endsWithSlash ? "" : basename(absoluteQuery).toLowerCase();
	try {
		const entries = await readdir(directory, { withFileTypes: true });
		return entries
			.filter(
				(entry) =>
					(!entry.name.startsWith(".") || prefix.startsWith(".")) &&
					entry.name.toLowerCase().includes(prefix),
			)
			.map((entry) => {
				const path = join(directory, entry.name);
				return displayPath(path, useTilde) + (entry.isDirectory() ? "/" : "");
			})
			.filter(isUseful);
	} catch {
		return [];
	}
}

async function locateEntries(absoluteQuery: string, useTilde: boolean): Promise<string[]> {
	const needle = basename(absoluteQuery);
	if (needle.length < 2) return [];
	const home = homedir();
	const root = dirname(absoluteQuery);
	if (root !== home && !root.startsWith(`${home}/`)) return [];
	try {
		const { stdout } = await execFileAsync("plocate", ["-i", "-l", "500", "-0", `${root}/*${needle}*`], {
			encoding: "utf8",
			maxBuffer: 4 * 1024 * 1024,
			timeout: SEARCH_TIMEOUT_MS,
			killSignal: "SIGKILL",
		});
		const results: string[] = [];
		for (const filePath of stdout.split("\0")) {
			if (!filePath.startsWith(`${root}/`) || !isUseful(filePath)) continue;
			try {
				const directory = (await stat(filePath)).isDirectory();
				results.push(displayPath(filePath, useTilde) + (directory ? "/" : ""));
			} catch {
				// Ignore stale locate entries.
			}
		}
		return results;
	} catch {
		return [];
	}
}

export function isFilesystemQuery(query: string): boolean {
	return query.startsWith("~/") || query.startsWith("/");
}

export function resolveFilesystemQuery(query: string, cwd: string): string | undefined {
	if (isFilesystemQuery(query)) return query;
	return resolve(cwd) === resolve(homedir()) ? `~/${query}` : undefined;
}

export async function searchFilesystem(query: string): Promise<string[]> {
	const useTilde = query.startsWith("~/");
	const absoluteQuery = useTilde ? join(homedir(), query.slice(2)) : query;
	const [direct, located] = await Promise.all([
		directEntries(absoluteQuery, useTilde),
		locateEntries(absoluteQuery, useTilde),
	]);
	return [...new Set([...direct, ...located])];
}
