/**
 * Agent discovery and configuration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { CONFIG_DIR_NAME, getAgentDir, parseFrontmatter } from "@earendil-works/pi-coding-agent";

export type AgentScope = "user" | "project" | "both";

export interface AgentConfig {
	name: string;
	description: string;
	tools?: string[];
	children?: string[];
	model?: string;
	workspace?: "inherit" | "worktree";
	workspaceSource?: "bundled" | "user" | "project";
	systemPrompt: string;
	source: "bundled" | "user" | "project";
	filePath: string;
}

export interface AgentDiscoveryResult {
	agents: AgentConfig[];
	projectAgentsDir: string | null;
}

/**
 * Raw agent frontmatter. Values are `unknown` because `parseFrontmatter` runs a
 * real YAML parser, so any scalar or collection can appear here.
 *
 * A type alias rather than an interface: `parseFrontmatter` constrains its
 * parameter to `Record<string, unknown>`, and only an alias picks up the
 * implicit index signature that satisfies it.
 */
type AgentFrontmatter = {
	name?: unknown;
	description?: unknown;
	tools?: unknown;
	children?: unknown;
	model?: unknown;
	workspace?: unknown;
};

/**
 * Normalize a frontmatter `tools` value to a list of tool names.
 *
 * Both spellings are valid YAML and both are in use:
 *
 *     tools: read, bash        # string
 *     tools: [read, bash]      # array
 *
 * so accept either. Anything else (a number, a map, a nested list) yields no
 * tools rather than throwing: this runs inside agent discovery, where a single
 * bad file must not take down every other agent in the same directory.
 */
export function parseNameList(value: unknown): string[] | undefined {
	const raw = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
	const names = raw
		.filter((item): item is string => typeof item === "string")
		.map((item) => item.trim())
		.filter((item) => /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(item));
	return names.length > 0 ? [...new Set(names)] : undefined;
}

function loadAgentsFromDir(dir: string, source: AgentConfig["source"]): AgentConfig[] {
	const agents: AgentConfig[] = [];

	if (!fs.existsSync(dir)) {
		return agents;
	}

	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(dir, { withFileTypes: true });
	} catch {
		return agents;
	}

	for (const entry of entries) {
		if (!entry.name.endsWith(".md")) continue;
		if (!entry.isFile() && !entry.isSymbolicLink()) continue;

		const filePath = path.join(dir, entry.name);
		let content: string;
		try {
			content = fs.readFileSync(filePath, "utf-8");
		} catch {
			continue;
		}

		let parsed: ReturnType<typeof parseFrontmatter<AgentFrontmatter>>;
		try {
			parsed = parseFrontmatter<AgentFrontmatter>(content);
		} catch {
			continue;
		}
		const { frontmatter, body } = parsed;

		if (typeof frontmatter.name !== "string" || typeof frontmatter.description !== "string") continue;

		const workspace =
			frontmatter.workspace === "worktree" || frontmatter.workspace === "inherit"
				? frontmatter.workspace
				: undefined;
		agents.push({
			name: frontmatter.name,
			description: frontmatter.description,
			tools: parseNameList(frontmatter.tools),
			children: parseNameList(frontmatter.children),
			model: typeof frontmatter.model === "string" ? frontmatter.model : undefined,
			workspace,
			workspaceSource: workspace ? source : undefined,
			systemPrompt: body,
			source,
			filePath,
		});
	}

	return agents;
}

function isDirectory(p: string): boolean {
	try {
		return fs.statSync(p).isDirectory();
	} catch {
		return false;
	}
}

function findNearestProjectAgentsDir(cwd: string): string | null {
	let currentDir = cwd;
	while (true) {
		const candidate = path.join(currentDir, CONFIG_DIR_NAME, "agents");
		if (isDirectory(candidate)) return candidate;

		const parentDir = path.dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

export function mergeAgentLayers(...layers: AgentConfig[][]): AgentConfig[] {
	const agentMap = new Map<string, AgentConfig>();
	for (const layer of layers) {
		for (const agent of layer) {
			const previous = agentMap.get(agent.name);
			if (agent.workspace === undefined && previous?.workspace !== undefined) {
				agentMap.set(agent.name, {
					...agent,
					workspace: previous.workspace,
					workspaceSource: previous.workspaceSource ?? previous.source,
				});
			} else {
				agentMap.set(agent.name, agent);
			}
		}
	}
	return [...agentMap.values()];
}

export function discoverAgents(cwd: string, scope: AgentScope): AgentDiscoveryResult {
	const bundledDir = path.join(import.meta.dirname, "agents");
	const userDir = path.join(getAgentDir(), "agents");
	const projectAgentsDir = findNearestProjectAgentsDir(cwd);

	const bundledAgents = loadAgentsFromDir(bundledDir, "bundled");
	const userAgents = scope === "project" ? [] : loadAgentsFromDir(userDir, "user");
	const projectAgents =
		scope === "user" || !projectAgentsDir ? [] : loadAgentsFromDir(projectAgentsDir, "project");

	return {
		agents: mergeAgentLayers(bundledAgents, userAgents, projectAgents),
		projectAgentsDir,
	};
}
