import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * Return a stable project key. Linked Git worktrees intentionally share the
 * main checkout's key; outside Git, the exact working directory is used.
 */
export async function resolveProjectRoot(cwd: string): Promise<string> {
	const fallback = resolve(cwd);
	try {
		const { stdout } = await execFileAsync(
			"git",
			["rev-parse", "--path-format=absolute", "--git-common-dir"],
			{ cwd, encoding: "utf8", timeout: 2_000 },
		);
		const commonDirectory = stdout.trim();
		return commonDirectory ? dirname(resolve(cwd, commonDirectory)) : fallback;
	} catch {
		return fallback;
	}
}
