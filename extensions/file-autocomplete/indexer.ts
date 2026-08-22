import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_INDEX_BYTES = 16 * 1024 * 1024;
const MAX_FILES = 100_000;
const REFRESH_INTERVAL_MS = 2_000;
const INDEX_TIMEOUT_MS = 5_000;
const EXCLUDED_DIRECTORIES = new Set([
	".git",
	".next",
	".turbo",
	"build",
	"coverage",
	"dist",
	"node_modules",
	"target",
	"vendor",
]);

async function listWithGit(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"git",
		["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
		{
			cwd,
			encoding: "utf8",
			maxBuffer: MAX_INDEX_BYTES,
			timeout: INDEX_TIMEOUT_MS,
			killSignal: "SIGKILL",
		},
	);
	return stdout;
}

async function listWithRipgrep(cwd: string): Promise<string> {
	const { stdout } = await execFileAsync(
		"rg",
		[
			"--files",
			"--hidden",
			"--null",
			"--glob",
			"!.git/**",
			"--glob",
			"!.next/**",
			"--glob",
			"!.turbo/**",
			"--glob",
			"!build/**",
			"--glob",
			"!coverage/**",
			"--glob",
			"!dist/**",
			"--glob",
			"!node_modules/**",
			"--glob",
			"!target/**",
			"--glob",
			"!vendor/**",
		],
		{
			cwd,
			encoding: "utf8",
			maxBuffer: MAX_INDEX_BYTES,
			timeout: INDEX_TIMEOUT_MS,
			killSignal: "SIGKILL",
		},
	);
	return stdout;
}

export function parseFileList(output: string): string[] {
	const files: string[] = [];
	for (const rawPath of output.split("\0")) {
		const path = rawPath.replaceAll("\\", "/").replace(/^\.\//, "");
		if (!path || path.split("/").some((segment) => EXCLUDED_DIRECTORIES.has(segment))) continue;
		files.push(path);
		if (files.length === MAX_FILES) break;
	}
	return files;
}

export async function buildProjectFileIndex(cwd: string): Promise<string[]> {
	try {
		return parseFileList(await listWithGit(cwd));
	} catch {
		try {
			return parseFileList(await listWithRipgrep(cwd));
		} catch {
			return [];
		}
	}
}

export class ProjectFileIndex {
	private files: string[] | undefined;
	private loading: Promise<string[]> | undefined;
	private loadedAt = 0;

	constructor(private readonly cwd: string) {}

	async get(): Promise<string[]> {
		if (!this.files) return this.load();
		if (Date.now() - this.loadedAt >= REFRESH_INTERVAL_MS) void this.load();
		return this.files;
	}

	private load(): Promise<string[]> {
		this.loading ??= buildProjectFileIndex(this.cwd).then((files) => {
			this.files = files;
			this.loadedAt = Date.now();
			this.loading = undefined;
			return files;
		});
		return this.loading;
	}
}
