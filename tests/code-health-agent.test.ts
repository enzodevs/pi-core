import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../extensions/subagent/agents.ts";

let cwd: string;

beforeEach(() => {
	cwd = fs.mkdtempSync(path.join(os.tmpdir(), "code-health-profile-test-"));
});

afterEach(() => {
	fs.rmSync(cwd, { recursive: true, force: true });
});

const discover = () => discoverAgents(cwd, "project").agents.find((agent) => agent.name === "code-health");

describe("bundled code-health agent", () => {
	it("is discoverable with writer isolation and caller-selected model/effort", () => {
		const agent = discover();
		expect(agent).toMatchObject({
			name: "code-health",
			source: "bundled",
			workspace: "worktree",
			workspaceSource: "bundled",
			children: ["reviewer"],
			tools: undefined,
		});
		expect(agent?.model).toBeUndefined();
	});

	it("requires the current global skill and separates assessment from implementation", () => {
		const prompt = discover()?.systemPrompt ?? "";
		expect(prompt).toContain("~/.agents/skills/pragmatic-solid/SKILL.md");
		expect(prompt).toContain("current user's home directory before filesystem calls");
		expect(prompt).toContain("Loading is mandatory");
		expect(prompt).toContain("report the blocker rather than substituting generic advice");
		expect(prompt).toContain("Assess and plan are read-only");
		expect(prompt).toContain("Implementation requests authorize relevant refactoring");
		expect(prompt).toContain("Never silently replace a requested WIP assessment with clean HEAD");
		expect(prompt).toContain("Read-only work must not edit or commit the target repository");
		expect(prompt).toContain("do not merge, push or delete the worktree");
		expect(prompt).toContain("checks actually run with baseline/regression distinctions");
	});

	it("preserves isolation when a project overrides only the prompt or model", () => {
		const directory = path.join(cwd, CONFIG_DIR_NAME, "agents");
		fs.mkdirSync(directory, { recursive: true });
		fs.writeFileSync(
			path.join(directory, "code-health.md"),
			"---\nname: code-health\ndescription: Project code health\nmodel: example/test\n---\nProject guidance.\n",
		);
		expect(discover()).toMatchObject({
			source: "project",
			model: "example/test",
			workspace: "worktree",
			workspaceSource: "bundled",
		});
	});
});
