import { readFile } from "node:fs/promises";
import type { ExtensionAPI, Skill } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, truncateHead } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { getSkillMode, loadConfig, saveConfig, setSkillMode } from "./config.js";
import { SkillIndexStore } from "./index-store.js";
import { getStoragePaths } from "./paths.js";
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

	const modeFor = (cwd: string, name: string) => getSkillMode(config, cwd, name);
	const refreshIndex = async (cwd: string, skills: readonly Skill[]) => {
		const indexed = skills.map((skill) => toIndexedSkill(skill, modeFor(cwd, skill.name)));
		const signature = JSON.stringify([cwd, indexed]);
		if (signature === lastIndexSignature) return;
		lastIndexSignature = signature;
		await index.update(cwd, indexed);
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
			const current = loadedSkills.map((skill) => toIndexedSkill(skill, modeFor(ctx.cwd, skill.name)));
			const matches = searchSkills(current, params.query, params.limit ?? 8);
			return {
				content: [
					{
						type: "text",
						text:
							matches.length === 0
								? `No enabled skills match: ${params.query}`
								: matches.map((skill) => `- ${skill.name} [${skill.mode}]: ${skill.description}`).join("\n") +
									"\n\nUse load_skill with a skill name to load its instructions.",
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
			const skill = loadedSkills.find(
				(candidate) => candidate.name === params.name && modeFor(ctx.cwd, candidate.name) !== "off",
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
		description: "Configure skill visibility for the current directory",
		handler: async (args, ctx) => {
			loadedSkills = ctx.getSystemPromptOptions().skills ?? [];
			const [name, requestedMode, ...extra] = args.trim().split(/\s+/).filter(Boolean);
			if (name && requestedMode && extra.length === 0) {
				if (!loadedSkills.some((skill) => skill.name === name)) {
					ctx.ui.notify(`Unknown skill: ${name}`, "error");
					return;
				}
				if (!isMode(requestedMode)) {
					ctx.ui.notify(`Mode must be one of: ${SKILL_MODES.join(", ")}`, "error");
					return;
				}
				config = setSkillMode(config, ctx.cwd, name, requestedMode);
				await saveConfig(paths.config, config);
				await refreshIndex(ctx.cwd, loadedSkills);
				ctx.ui.notify(`${name}: ${requestedMode}`, "info");
				return;
			}
			if (args.trim()) {
				ctx.ui.notify("Usage: /skill-manager [skill-name mode]", "error");
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("Interactive skill manager requires TUI mode", "error");
				return;
			}
			let pendingSave = Promise.resolve();
			await showSkillManager(
				ctx,
				loadedSkills.map((skill) => ({
					name: skill.name,
					description: skill.description,
					mode: modeFor(ctx.cwd, skill.name),
				})),
				(name, mode) => {
					config = setSkillMode(config, ctx.cwd, name, mode);
					pendingSave = pendingSave.then(() => saveConfig(paths.config, config));
				},
			);
			await pendingSave;
			await refreshIndex(ctx.cwd, loadedSkills);
		},
	});

	pi.on("before_agent_start", async (event, ctx) => {
		loadedSkills = event.systemPromptOptions.skills ?? [];
		await refreshIndex(ctx.cwd, loadedSkills);
		const section = renderManagedSkills(loadedSkills, (name) => modeFor(ctx.cwd, name));
		return { systemPrompt: replaceSkillsSection(event.systemPrompt, section) };
	});
}
