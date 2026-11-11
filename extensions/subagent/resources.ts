import { homedir } from "node:os";
import * as path from "node:path";
import { parseArgs } from "@earendil-works/pi-coding-agent";

/** Forward resource overrides, never the parent's task, session, credentials or system prompt. */
export function inheritResourceArgs(
	argv: string[],
	cwd: string,
	getFlag?: (name: string) => boolean | string | undefined,
): string[] {
	const parent = parseArgs(argv);
	const args: string[] = [];
	for (const [flag, paths] of [
		["--extension", parent.extensions],
		["--skill", parent.skills],
		["--prompt-template", parent.promptTemplates],
		["--theme", parent.themes],
	] as const) {
		for (const resource of paths ?? []) {
			// Match Pi's local resource syntax. Package sources are resolved by Pi itself.
			const resolved = /^(builtin:|npm:|git:|https?:|git@)/.test(resource)
				? resource
				: resource.startsWith("~/")
					? path.join(homedir(), resource.slice(2))
					: path.resolve(cwd, resource);
			args.push(flag, resolved);
		}
	}
	// Explicit parent opt-outs still apply; being a child no longer introduces any.
	for (const [flag, enabled] of [
		["--no-extensions", parent.noExtensions],
		["--no-skills", parent.noSkills],
		["--no-prompt-templates", parent.noPromptTemplates],
		["--no-themes", parent.noThemes],
		["--no-context-files", parent.noContextFiles],
		["--no-mcp", parent.noMcp],
		["--offline", parent.offline],
	] as const) {
		if (enabled) args.push(flag);
	}
	if (parent.projectTrustOverride !== undefined)
		args.push(parent.projectTrustOverride ? "--approve" : "--no-approve");
	if (parent.excludeTools?.length) args.push("--exclude-tools", parent.excludeTools.join(","));
	for (const name of parent.unknownFlags.keys()) {
		const value = getFlag?.(name);
		if (value !== undefined) args.push(value === true ? `--${name}` : `--${name}=${value}`);
	}
	return args;
}
