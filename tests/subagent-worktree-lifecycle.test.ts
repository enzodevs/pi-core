import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	lifecycleSummary,
	normalizeVerification,
	WorktreeLifecycle,
} from "../extensions/subagent/worktree-lifecycle.ts";
import { WorktreeLedger } from "../extensions/subagent/worktree-reaper.ts";
import { type CommandRunner, defaultCommandRunner } from "../extensions/subagent/worktrunk.ts";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const git = (cwd: string, ...args: string[]) =>
	execFileSync("git", args, {
		cwd,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
		env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" },
	}).trim();

async function fixture() {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-lifecycle-")));
	roots.push(base);
	const primary = path.join(base, "main");
	const cwd = path.join(base, "worker");
	fs.mkdirSync(primary);
	git(primary, "init", "-b", "main");
	git(primary, "config", "user.name", "Lifecycle test");
	git(primary, "config", "user.email", "test@example.invalid");
	git(primary, "config", "core.hooksPath", path.join(primary, ".git/hooks"));
	fs.writeFileSync(path.join(primary, "base.txt"), "base\n");
	git(primary, "add", ".");
	git(primary, "commit", "-m", "base");
	git(primary, "worktree", "add", "-b", "pi-agent/worker-0123456789ab", cwd);
	fs.writeFileSync(path.join(cwd, "feature.txt"), "feature\n");
	git(cwd, "add", ".");
	git(cwd, "commit", "-m", "feature");
	const head = git(cwd, "rev-parse", "HEAD");
	const id = "0123456789ab";
	const ledger = new WorktreeLedger(path.join(base, "state/worktrees.json"));
	await ledger.record(cwd, id, true);
	await ledger.markTerminal(id);
	const hooks = [{ type: "pre-merge", source: "project", template: "make check", needs_approval: false }];
	const run: CommandRunner = async (command, args, directory) => {
		if (command === "wt" && args.includes("default-branch")) return { stdout: "main\n", stderr: "" };
		if (command === "wt" && args.includes("show")) return { stdout: JSON.stringify(hooks), stderr: "" };
		return defaultCommandRunner(command, args, directory);
	};
	const check = vi.fn(async () => ({
		status: "complete" as const,
		exitCode: 0,
		logPath: path.join(base, "checks/12345678.log"),
	}));
	const options = { ledger, logRoot: path.join(base, "checks"), run, check };
	return {
		base,
		primary,
		cwd,
		id,
		head,
		ledger,
		hooks,
		run,
		check,
		options,
		lifecycle: new WorktreeLifecycle(options),
	};
}

describe("harness verification receipts", () => {
	it("records the exact clean commit, target and approved hooks", async () => {
		const f = await fixture();
		const result = await f.lifecycle.verify(f.cwd, f.id);
		expect(result).toMatchObject({
			state: "passed",
			workspace: { head: f.head, target: "main", targetCwd: f.primary },
			hooksHash: expect.stringMatching(/^[a-f0-9]{64}$/),
		});
		expect(f.check).toHaveBeenCalledOnce();
		expect(normalizeVerification(JSON.parse(JSON.stringify(result)))).toEqual(result);
		expect(lifecycleSummary(result)).toContain(`revision: ${f.head}`);
	});

	it.each(["missing", "unapproved"])("does not treat %s checks as a green verification", async (kind) => {
		const f = await fixture();
		if (kind === "missing") f.hooks.splice(0);
		else {
			const hook = f.hooks[0];
			if (hook) hook.needs_approval = true;
		}
		const result = await f.lifecycle.verify(f.cwd, f.id);
		expect(result.state).toBe("blocked");
		expect(f.check).not.toHaveBeenCalled();
	});

	it("does not auto-commit dirty work or verify while another child is active", async () => {
		const f = await fixture();
		fs.writeFileSync(path.join(f.cwd, "dirty.txt"), "keep");
		expect((await f.lifecycle.verify(f.cwd, f.id)).state).toBe("blocked");
		fs.unlinkSync(path.join(f.cwd, "dirty.txt"));
		await f.ledger.record(f.cwd, "sibling", false);
		expect((await f.lifecycle.verify(f.cwd, f.id)).summary).toContain("Another agent");
		expect(f.check).not.toHaveBeenCalled();
		expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.head);
	});

	it("reports failed hooks with a log reference and no passing receipt", async () => {
		const f = await fixture();
		const lifecycle = new WorktreeLifecycle({
			...f.options,
			check: async () => ({ status: "failed", exitCode: 9, logPath: "/private/check.log" }),
		});
		const result = await lifecycle.verify(f.cwd, f.id);
		expect(result).toMatchObject({
			state: "failed",
			logPath: "/private/check.log",
			summary: expect.stringContaining("exit 9"),
		});
		await expect(lifecycle.integrate(f.cwd, f.id, result, f.head)).rejects.toThrow("passed verification");
	});

	it("invalidates a successful check that modifies tracked or untracked source", async () => {
		const f = await fixture();
		f.check.mockImplementationOnce(async () => {
			fs.writeFileSync(path.join(f.cwd, "feature.txt"), "changed by formatter\n");
			return { status: "complete", exitCode: 0, logPath: "/private/check.log" };
		});
		expect((await f.lifecycle.verify(f.cwd, f.id)).state).toBe("blocked");
	});

	it("cancels verification without publishing a passing receipt", async () => {
		const f = await fixture();
		const controller = new AbortController();
		const lifecycle = new WorktreeLifecycle({
			...f.options,
			check: async () => {
				controller.abort();
				return { status: "stopped", exitCode: null, logPath: "/private/check.log" };
			},
		});
		expect((await lifecycle.verify(f.cwd, f.id, controller.signal)).state).toBe("interrupted");
	});

	it("cancels while another parent owns the lifecycle lock", async () => {
		const f = await fixture();
		let release!: () => void;
		let entered!: () => void;
		const enteredPromise = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const holding = f.ledger.withIdleWorktree(
			f.cwd,
			f.id,
			() =>
				new Promise<void>((resolve) => {
					release = resolve;
					entered();
				}),
		);
		await enteredPromise;
		try {
			const controller = new AbortController();
			const verifying = f.lifecycle.verify(f.cwd, f.id, controller.signal);
			controller.abort();
			expect((await verifying).state).toBe("interrupted");
			expect(f.check).not.toHaveBeenCalled();
		} finally {
			release();
			await holding;
		}
	});

	it("rejects malformed restored passing receipts and bounds the rendered summary", () => {
		expect(normalizeVerification({ state: "passed", summary: "claimed success" })).toBeUndefined();
		expect(
			Buffer.byteLength(lifecycleSummary({ state: "failed", summary: "x".repeat(10000) })),
		).toBeLessThanOrEqual(2048);
	});
});

describe("explicit exact-commit integration", () => {
	it("fast-forwards only the verified revision and safely reconciles retries after cleanup", async () => {
		const f = await fixture();
		const verified = await f.lifecycle.verify(f.cwd, f.id);
		const result = await f.lifecycle.integrate(f.cwd, f.id, verified, f.head);
		expect(result.state).toBe("integrated");
		expect(git(f.primary, "rev-parse", "HEAD")).toBe(f.head);
		expect(fs.readFileSync(path.join(f.primary, "feature.txt"), "utf8")).toBe("feature\n");
		git(f.primary, "worktree", "remove", f.cwd);
		expect((await f.lifecycle.integrate(f.cwd, f.id, verified, f.head)).summary).toContain(
			"already integrated",
		);
	});

	it("requires the exact reviewed revision rather than silently accepting a new tip", async () => {
		const f = await fixture();
		const verified = await f.lifecycle.verify(f.cwd, f.id);
		await expect(f.lifecycle.integrate(f.cwd, f.id, verified, "a".repeat(40))).rejects.toThrow(
			"exact reviewed revision",
		);
		git(f.cwd, "commit", "--allow-empty", "-m", "new unreviewed tip");
		const result = await f.lifecycle.integrate(f.cwd, f.id, verified, f.head);
		expect(result).toMatchObject({ state: "failed", summary: expect.stringContaining("stale") });
		expect(git(f.primary, "rev-parse", "HEAD")).not.toBe(f.head);
	});

	it.each(["target", "hooks"])("rejects verification invalidated by changed %s", async (kind) => {
		const f = await fixture();
		const verified = await f.lifecycle.verify(f.cwd, f.id);
		if (kind === "target") git(f.primary, "commit", "--allow-empty", "-m", "target moved");
		else {
			const hook = f.hooks[0];
			if (hook) hook.template = "different checks";
		}
		const before = git(f.primary, "rev-parse", "HEAD");
		expect((await f.lifecycle.integrate(f.cwd, f.id, verified, f.head)).state).toBe("failed");
		expect(git(f.primary, "rev-parse", "HEAD")).toBe(before);
	});

	it("preserves unrelated dirty files in the target and refuses integration", async () => {
		const f = await fixture();
		const verified = await f.lifecycle.verify(f.cwd, f.id);
		fs.writeFileSync(path.join(f.primary, "user-work.txt"), "keep me");
		const result = await f.lifecycle.integrate(f.cwd, f.id, verified, f.head);
		expect(result).toMatchObject({ state: "failed", summary: expect.stringContaining("dirty") });
		expect(fs.readFileSync(path.join(f.primary, "user-work.txt"), "utf8")).toBe("keep me");
	});

	it("does not rebase or leave merge state when the target has diverged", async () => {
		const f = await fixture();
		git(f.primary, "commit", "--allow-empty", "-m", "diverged target");
		const verified = await f.lifecycle.verify(f.cwd, f.id);
		expect(verified.state).toBe("passed");
		const before = git(f.primary, "rev-parse", "HEAD");
		expect((await f.lifecycle.integrate(f.cwd, f.id, verified, f.head)).state).toBe("failed");
		expect(git(f.primary, "rev-parse", "HEAD")).toBe(before);
		expect(git(f.cwd, "rev-parse", "HEAD")).toBe(f.head);
		expect(fs.existsSync(path.join(f.primary, ".git/MERGE_HEAD"))).toBe(false);
	});

	it("pins integration to the reviewed SHA even if the source branch moves at merge time", async () => {
		const f = await fixture();
		const verified = await f.lifecycle.verify(f.cwd, f.id);
		const lifecycle = new WorktreeLifecycle({
			...f.options,
			run: async (command, args, cwd) => {
				if (command === "git" && args[0] === "merge")
					git(f.cwd, "commit", "--allow-empty", "-m", "unreviewed concurrent tip");
				return f.run(command, args, cwd);
			},
		});
		expect((await lifecycle.integrate(f.cwd, f.id, verified, f.head)).state).toBe("integrated");
		expect(git(f.primary, "rev-parse", "HEAD")).toBe(f.head);
		expect(git(f.cwd, "rev-parse", "HEAD")).not.toBe(f.head);
	});

	it("reconciles a ref update even when the merge acknowledgement fails", async () => {
		const f = await fixture();
		const verified = await f.lifecycle.verify(f.cwd, f.id);
		let merges = 0;
		const lifecycle = new WorktreeLifecycle({
			...f.options,
			run: async (command, args, cwd) => {
				const result = await f.run(command, args, cwd);
				if (command === "git" && args[0] === "merge") {
					merges++;
					throw new Error("acknowledgement lost after ref update");
				}
				return result;
			},
		});
		expect((await lifecycle.integrate(f.cwd, f.id, verified, f.head)).state).toBe("integrated");
		expect((await lifecycle.integrate(f.cwd, f.id, verified, f.head)).state).toBe("integrated");
		expect(merges).toBe(1);
	});

	it("does not begin a cancelled integration", async () => {
		const f = await fixture();
		const verified = await f.lifecycle.verify(f.cwd, f.id);
		const controller = new AbortController();
		controller.abort();
		expect((await f.lifecycle.integrate(f.cwd, f.id, verified, f.head, controller.signal)).state).toBe(
			"interrupted",
		);
		expect(git(f.primary, "rev-parse", "HEAD")).not.toBe(f.head);
	});
});
