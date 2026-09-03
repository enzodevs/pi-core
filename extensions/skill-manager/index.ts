import { readFile } from "node:fs/promises";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
	clearGlobalSkillMode,
	clearProjectSkillMode,
	getSkillMode,
	loadConfig,
	resolveSkillMode,
	saveConfig,
	setGlobalSkillMode,
	setProjectSkillMode,
} from "./config.js";
import { SkillIndexStore } from "./index-store.js";
import { getStoragePaths } from "./paths.js";
import { resolveProjectRoot } from "./project-root.js";
import { renderManagedSkills, replaceSkillsSection } from "./prompt.js";
import { searchSkills } from "./search.js";
import { SKILL_MODES, type SkillManagerConfig, type SkillMode, toIndexedSkill } from "./types.js";
import { showSkillManager } from "./ui.js";

function isMode(value: string): value is SkillMode {
	return SKILL_MODES.includes(value as SkillMode);
}

export default async function skillManager(pi: ExtensionAPI) {
	const paths = getStoragePaths();
	let config: SkillManagerConfig = await loadConfig(paths.config);
	const index = new SkillIndexStore(paths.index);
	await index.load();
	let loadedSkills: Skill[] = [];
	let lastIndexSignature = "";

	const modeFor = (project: string, name: string) => getSkillMode(config, project, name);
	const refreshIndex = async (project: string, skills: readonly Skill[]) => {
		const indexed = skills.map((skill) => toIndexedSkill(skill, modeFor(project, skill.name)));
		const signature = JSON.stringify([project, indexed]);
		if (signature === lastIndexSignature) return;
		lastIndexSignature = signature;
		await index.update(project, indexed);
	};

	pi.registerTool({
		name: "search_skills",
		label: "Search Skills",
		description:
			"Search the enabled skill catalog for capabilities relevant to a task. Off skills are never returned.",
		parameters: Type.Object({
			query: Type.String({ description: "Capability or task to search for" }),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })),
		}),
		async execute(_id, params, _signal, _update, ctx) {
			const project = await resolveProjectRoot(ctx.cwd);
			const current = loadedSkills.map((skill) => toIndexedSkill(skill, modeFor(project, skill.name)));
			const matches = searchSkills(current, params.query, params.limit ?? 8);
			return {
				content: [
					{
						type: "text",
						text:
							matches.length === 0
								? `No enabled skills match: ${params.query}`
								: `${matches.map((skill) => `- ${skill.name} [${skill.mode}]: ${skill.description}`).join("\n")}\n\nUse load_skill with a skill name to load its instructions.`,
					},
				],
				details: { matches: matches.map(({ name, mode }) => ({ name, mode })) },
			};
		},
	});

	pi.registerTool({
		name: "load_skill",
		label: "Load Skill",
		description:
			"Load the SKILL.md instructions for an enabled skill by exact name. Off skills are unavailable.",
		parameters: Type.Object({ name: Type.String({ description: "Exact skill name" }) }),
		async execute(_id, params, _signal, _update, ctx) {
			const project = await resolveProjectRoot(ctx.cwd);
			const skill = loadedSkills.find(
				(candidate) => candidate.name === params.name && modeFor(project, candidate.name) !== "off",
			);
			if (!skill) throw new Error(`Enabled skill not found: ${params.name}`);
			const content = await readFile(skill.filePath, "utf8");
			const truncated = truncateHead(content, { maxBytes: DEFAULT_MAX_BYTES, maxLines: DEFAULT_MAX_LINES });
			let text = `Skill: ${skill.name}\nLocation: ${skill.filePath}\n\n${truncated.content}`;
			if (truncated.truncated) text += "\n\n[Skill content truncated at Pi's standard tool-output limit.]";
			return { content: [{ type: "text", text }], details: { name: skill.name, path: skill.filePath } };
		},
	});

	pi.registerCommand("skill-manager", {
		description: "Configure project or global skill visibility",
		handler: async (args, ctx) => {
			loadedSkills = ctx.getSystemPromptOptions().skills ?? [];
			const tokens = args.trim().split(/\s+/).filter(Boolean);
			const global = tokens[0] === "--global";
			if (global) tokens.shift();
			const [name, requestedMode, ...extra] = tokens;
			const project = await resolveProjectRoot(ctx.cwd);
			const scope = global ? "global" : "project";

			if (name && requestedMode && extra.length === 0) {
				if (!loadedSkills.some((skill) => skill.name === name)) {
					ctx.ui.notify(`Unknown skill: ${name}`, "error");
					return;
				}
				if (requestedMode !== "inherit" && !isMode(requestedMode)) {
					ctx.ui.notify(`Mode must be one of: ${SKILL_MODES.join(", ")}, inherit`, "error");
					return;
				}
				config = await loadConfig(paths.config);
				if (requestedMode === "inherit") {
					config = global ? clearGlobalSkillMode(config, name) : clearProjectSkillMode(config, project, name);
				} else {
					config = global
						? setGlobalSkillMode(config, name, requestedMode)
						: setProjectSkillMode(config, project, name, requestedMode);
				}
				await saveConfig(paths.config, config);
				await refreshIndex(project, loadedSkills);
				const effective = resolveSkillMode(config, project, name);
				ctx.ui.notify(`${name}: ${effective.mode} (${effective.source})`, "info");
				return;
			}
			if (tokens.length > 0) {
				ctx.ui.notify("Usage: /skill-manager [--global] [skill-name mode|inherit]", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Interactive skill manager requires TUI mode", "error");
				return;
			}
			config = await loadConfig(paths.config);
			let pendingSave = Promise.resolve();
			await showSkillManager(
				ctx,
				loadedSkills.map((skill) => ({
					name: skill.name,
					description: skill.description,
					defaultMode: config.defaultMode,
					globalMode: config.globalSkills[skill.name],
					projectMode: config.projects[project]?.skills[skill.name],
				})),
				(changedScope, name, mode) => {
					if (mode === "inherit") {
						config =
							changedScope === "global"
								? clearGlobalSkillMode(config, name)
								: clearProjectSkillMode(config, project, name);
					} else {
						config =
							changedScope === "global"
								? setGlobalSkillMode(config, name, mode)
								: setProjectSkillMode(config, project, name, mode);
					}
					pendingSave = pendingSave.then(() => saveConfig(paths.config, config));
				},
				scope,
			);
			await pendingSave;
			await refreshIndex(project, loadedSkills);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		loadedSkills = event.systemPromptOptions.skills ?? [];
		const project = await resolveProjectRoot(ctx.cwd);
		await refreshIndex(project, loadedSkills);
		const section = renderManagedSkills(loadedSkills, (name) => modeFor(project, name));
		return { systemPrompt: replaceSkillsSection(event.systemPrompt, section) };
	});
}
