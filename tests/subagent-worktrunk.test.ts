import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverAgents } from "../extensions/subagent/agents.ts";
import { type CommandRunner, prepareWorkspace, worktreeBranch } from "../extensions/subagent/worktrunk.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function fixture() {
	const base = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-worktrunk-"));
	roots.push(base);
	const root = path.join(base, "repo");
	const worktree = path.join(base, "worker");
	fs.mkdirSync(root);
	fs.mkdirSync(worktree);
	return { base, root, worktree };
}

function runnerFor(options: {
	root: string;
	worktree: string;
	linked?: boolean;
	dirty?: boolean;
	onWorktrunk?: (args: string[]) => void;
}): CommandRunner {
	return async (command, args) => {
		const joined = args.join(" ");
		if (command === "wt") {
			options.onWorktrunk?.(args);
			return { stdout: "", stderr: "" };
		}
		if (joined === "rev-parse --show-toplevel") return { stdout: `${options.root}\n`, stderr: "" };
		if (joined === "rev-parse --absolute-git-dir") {
			return {
				stdout: `${options.linked ? path.join(options.root, ".git/worktrees/worker") : path.join(options.root, ".git")}\n`,
				stderr: "",
			};
		}
		if (joined === "rev-parse --path-format=absolute --git-common-dir") {
			return { stdout: `${path.join(options.root, ".git")}\n`, stderr: "" };
		}
		if (joined === "status --porcelain") {
			return { stdout: options.dirty ? " M file.ts\n" : "", stderr: "" };
		}
		if (joined === "worktree list --porcelain") {
			return {
				stdout: `worktree ${options.root}\nHEAD aaaaaaa\nbranch refs/heads/main\n\nworktree ${options.worktree}\nHEAD bbbbbbb\nbranch refs/heads/pi-agent/worker-abc12345\n`,
				stderr: "",
			};
		}
		throw new Error(`Unexpected command: ${command} ${joined}`);
	};
}

describe("Worktrunk workspace policy", () => {
	it("marks the bundled writing worker for Worktrunk isolation", () => {
		const worker = discoverAgents(path.join(os.tmpdir(), "pi-core-no-user-agents"), "project").agents.find(
			(agent) => agent.name === "worker",
		);
		expect(worker?.workspace).toBe("worktree");
	});

	it("inherits the requested cwd without invoking Git", async () => {
		const run: CommandRunner = async () => {
			throw new Error("should not run");
		};
		await expect(
			prepareWorkspace({ mode: "inherit", cwd: "/tmp/project", agent: "worker", id: "abc", run }),
		).resolves.toEqual({ mode: "inherit", cwd: "/tmp/project", created: false, linkedWorktree: false });
	});

	it("reuses an existing linked worktree", async () => {
		const { worktree } = fixture();
		const result = await prepareWorkspace({
			mode: "worktree",
			cwd: worktree,
			agent: "worker",
			id: "abc12345",
			run: runnerFor({ root: worktree, worktree, linked: true }),
		});
		expect(result).toEqual({ mode: "worktree", cwd: worktree, created: false, linkedWorktree: true });
	});

	it("creates a clean primary-checkout worktree through Worktrunk", async () => {
		const { root, worktree } = fixture();
		let wtArgs: string[] = [];
		const result = await prepareWorkspace({
			mode: "worktree",
			cwd: root,
			agent: "worker",
			id: "abc12345",
			run: runnerFor({ root, worktree, onWorktrunk: (args) => (wtArgs = args) }),
		});
		expect(wtArgs).toEqual(["-C", root, "switch", "--create", "pi-agent/worker-abc12345", "--base", "HEAD"]);
		expect(result).toEqual({
			mode: "worktree",
			cwd: worktree,
			branch: "pi-agent/worker-abc12345",
			created: true,
			linkedWorktree: true,
		});
	});

	it("fails before Worktrunk when the primary checkout is dirty", async () => {
		const { root, worktree } = fixture();
		await expect(
			prepareWorkspace({
				mode: "worktree",
				cwd: root,
				agent: "worker",
				id: "abc12345",
				run: runnerFor({ root, worktree, dirty: true }),
			}),
		).rejects.toThrow("dirty checkout");
	});

	it("rejects reuse of a dirty linked worktree", async () => {
		const { worktree } = fixture();
		await expect(
			prepareWorkspace({
				mode: "worktree",
				cwd: worktree,
				agent: "worker",
				id: "abc12345",
				run: runnerFor({ root: worktree, worktree, linked: true, dirty: true }),
			}),
		).rejects.toThrow("dirty checkout");
	});

	it("rejects a dependency directory shared outside an existing worktree", async () => {
		const { base, worktree } = fixture();
		const shared = path.join(base, "shared-vendor");
		fs.mkdirSync(shared);
		fs.symlinkSync(shared, path.join(worktree, "vendor"));
		await expect(
			prepareWorkspace({
				mode: "worktree",
				cwd: worktree,
				agent: "worker",
				id: "abc12345",
				run: runnerFor({ root: worktree, worktree, linked: true }),
			}),
		).rejects.toThrow("Unsafe shared dependency directory");
	});

	it("creates bounded predictable branch names", () => {
		expect(worktreeBranch("Code Worker!", "abc12345")).toBe("pi-agent/code-worker-abc12345");
	});
});
