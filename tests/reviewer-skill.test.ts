import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { discoverAgents } from "../extensions/subagent/agents.ts";

const root = path.resolve(import.meta.dirname, "..");

describe("packaged evidence-first reviewer", () => {
	it("ships a generated skill whose runtime files match its provenance manifest", () => {
		const output = execFileSync(process.execPath, ["scripts/sync-review-skill.mjs", "--check"], {
			cwd: root,
			encoding: "utf8",
		});
		expect(output).toContain("runtime files verified");
	});

	it("rejects drift and regenerates from the explicit source without formatter repair", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-sync-test-"));
		const vendor = "extensions/subagent/reviewer-skill";
		try {
			fs.mkdirSync(path.join(cwd, "scripts"));
			fs.copyFileSync(
				path.join(root, "scripts/sync-review-skill.mjs"),
				path.join(cwd, "scripts/sync-review-skill.mjs"),
			);
			fs.cpSync(path.join(root, vendor), path.join(cwd, vendor), { recursive: true });
			fs.cpSync(path.join(root, vendor), path.join(cwd, "author"), { recursive: true });
			const run = (...args: string[]) =>
				execFileSync(process.execPath, ["scripts/sync-review-skill.mjs", ...args], {
					cwd,
					encoding: "utf8",
					stdio: "pipe",
				});
			fs.appendFileSync(path.join(cwd, vendor, "SKILL.md"), "\nUnauthorized drift\n");
			expect(() => run("--check")).toThrow();
			expect(run("--write", "--source", path.join(cwd, "author"))).toContain("verified");
			expect(fs.readFileSync(path.join(cwd, vendor, "source-manifest.json"), "utf8")).toContain(
				'\n\t"schema_version"',
			);
			fs.appendFileSync(path.join(cwd, "author/SKILL.md"), "\nNew authored content\n");
			expect(() => run("--check", "--source", path.join(cwd, "author"))).toThrow();
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});

	it("inherits WIP, requires loading the skill and separates artifacts from source edits", () => {
		const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "reviewer-profile-test-"));
		try {
			const reviewer = discoverAgents(cwd, "project").agents.find((agent) => agent.name === "reviewer");
			expect(reviewer?.source).toBe("bundled");
			expect(reviewer?.workspace).toBe("inherit");
			expect(reviewer?.tools).toEqual(["read", "bash", "edit", "write", "grep", "find", "ls"]);
			expect(reviewer?.systemPrompt).toContain("{{REVIEW_SKILL_DIR}}/SKILL.md");
			expect(reviewer?.systemPrompt).toContain("Loading is mandatory");
			expect(reviewer?.systemPrompt).toContain("Never edit, stage, commit");
			expect(reviewer?.systemPrompt).toContain("pause writers");
		} finally {
			fs.rmSync(cwd, { recursive: true, force: true });
		}
	});
});
