import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { workspaceResultText } from "../extensions/subagent/index.ts";
import {
	discoverLegacyWorktrees,
	formatReapResult,
	processInside,
	reapIntegratedWorktrees,
	WorktreeLedger,
} from "../extensions/subagent/worktree-reaper.ts";
import type { CommandRunner } from "../extensions/subagent/worktrunk.ts";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

const DAY = 24 * 60 * 60 * 1000;

function fixture() {
	const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-reaper-")));
	roots.push(base);
	const primary = path.join(base, "repo");
	const worktree = path.join(base, "repo.pi-agent-worker-abc");
	fs.mkdirSync(primary);
	fs.mkdirSync(worktree);
	let clock = 1_000_000;
	const ledger = new WorktreeLedger(path.join(base, "state", "worktrees.json"), () => clock);
	return { base, primary, worktree, ledger, advance: (ms: number) => (clock += ms), now: () => clock };
}

type Item = Record<string, unknown>;

function item(worktree: string, overrides: Item = {}): Item {
	return {
		branch: "pi-agent/worker-abc",
		path: worktree,
		is_main: false,
		main_state: "integrated",
		worktree: { detached: false },
		working_tree: { staged: false, modified: false, untracked: false, renamed: false, deleted: false },
		...overrides,
	};
}

function runner(primary: string, items: Item[], removeFails = false) {
	const calls: string[][] = [];
	const run: CommandRunner = async (command, args) => {
		calls.push([command, ...args]);
		if (command === "wt" && args.includes("list")) {
			return {
				stdout: JSON.stringify([{ branch: "main", path: primary, is_main: true }, ...items]),
				stderr: "",
			};
		}
		if (command === "wt" && args.includes("remove")) {
			if (removeFails) throw new Error("wt failed (1): worktree has uncommitted changes");
			return { stdout: "", stderr: "" };
		}
		throw new Error(`Unexpected command: ${command} ${args.join(" ")}`);
	};
	return { run, calls, removals: () => calls.filter((call) => call.includes("remove")) };
}

async function terminalEntry(f: ReturnType<typeof fixture>) {
	await f.ledger.record(f.worktree, "abc", true);
	await f.ledger.markTerminal("abc");
}

describe("agent worktree reaping", () => {
	it("removes an integrated, clean worktree of a finished run without force flags", async () => {
		const f = fixture();
		await terminalEntry(f);
		const wt = runner(f.primary, [item(f.worktree)]);

		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});

		expect(result.removed).toEqual([f.worktree]);
		expect(wt.removals()).toEqual([["wt", "-C", f.primary, "remove", f.worktree, "--foreground"]]);
		expect(await f.ledger.entries()).toEqual([]);
	});

	it("treats a branch on the same commit as the default branch as integrated", async () => {
		const f = fixture();
		await terminalEntry(f);
		const wt = runner(f.primary, [item(f.worktree, { main_state: "empty" })]);

		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});

		expect(result.removed).toEqual([f.worktree]);
	});

	it.each([
		["ahead", "not integrated (ahead)"],
		["diverged", "not integrated (diverged)"],
	])("keeps unintegrated work (%s)", async (state, reason) => {
		const f = fixture();
		await terminalEntry(f);
		const wt = runner(f.primary, [item(f.worktree, { main_state: state })]);

		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});

		expect(result.retained).toEqual([{ path: f.worktree, reason }]);
		expect(wt.removals()).toEqual([]);
		expect((await f.ledger.entries()).map((entry) => entry.path)).toEqual([f.worktree]);
	});

	it("keeps a worktree with uncommitted or unknown working-tree state", async () => {
		const f = fixture();
		await terminalEntry(f);
		const dirty = runner(f.primary, [
			item(f.worktree, {
				working_tree: { staged: false, modified: true, untracked: false, renamed: false, deleted: false },
			}),
		]);
		const unknown = runner(f.primary, [item(f.worktree, { working_tree: { modified: false } })]);

		const first = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: dirty.run,
			busy: () => false,
			now: f.now,
		});
		const second = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: unknown.run,
			busy: () => false,
			now: f.now,
		});

		expect(first.retained[0]?.reason).toBe("uncommitted changes");
		expect(second.retained[0]?.reason).toBe("uncommitted changes");
		expect([...dirty.removals(), ...unknown.removals()]).toEqual([]);
	});

	it("keeps a worktree while its run is active, but not after the run is abandoned for a day", async () => {
		const f = fixture();
		await f.ledger.record(f.worktree, "abc", true);
		const wt = runner(f.primary, [item(f.worktree, { main_state: "empty" })]);

		const active = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});
		expect(active.retained).toEqual([{ path: f.worktree, reason: "agent still running" }]);

		f.advance(DAY + 1);
		const abandoned = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});
		expect(abandoned.removed).toEqual([f.worktree]);
	});

	it("keeps a worktree that a process is working inside", async () => {
		const f = fixture();
		await terminalEntry(f);
		const wt = runner(f.primary, [item(f.worktree)]);

		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: (candidate) => candidate === f.worktree,
			now: f.now,
		});

		expect(result.retained).toEqual([
			{ path: f.worktree, reason: "a process is working inside or process visibility is unavailable" },
		]);
		expect(wt.removals()).toEqual([]);
	});

	it("never removes detached checkouts such as release pins, and stops tracking them", async () => {
		const f = fixture();
		await terminalEntry(f);
		const wt = runner(f.primary, [item(f.worktree, { branch: null, worktree: { detached: true } })]);

		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});

		expect(result.retained).toEqual([{ path: f.worktree, reason: "primary or detached checkout" }]);
		expect(wt.removals()).toEqual([]);
		expect(await f.ledger.entries()).toEqual([]);
	});

	it("forgets worktrees that no longer exist without calling Worktrunk", async () => {
		const f = fixture();
		await terminalEntry(f);
		fs.rmSync(f.worktree, { recursive: true });
		const wt = runner(f.primary, []);

		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});

		expect(result).toEqual({ removed: [], retained: [] });
		expect(wt.calls).toEqual([]);
		expect(await f.ledger.entries()).toEqual([]);
	});

	it("keeps the entry when Worktrunk refuses the removal", async () => {
		const f = fixture();
		await terminalEntry(f);
		const wt = runner(f.primary, [item(f.worktree)], true);

		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});

		expect(result.removed).toEqual([]);
		expect(result.retained[0]?.reason).toMatch(/^wt remove refused: .*uncommitted/);
		expect((await f.ledger.entries()).map((entry) => entry.path)).toEqual([f.worktree]);
	});

	it("only considers worktrees recorded in the ledger", async () => {
		const f = fixture();
		const wt = runner(f.primary, [item(f.worktree)]);

		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});

		expect(result).toEqual({ removed: [], retained: [] });
		expect(wt.calls).toEqual([]);
	});
});

function gate() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function linkedRunner(f: ReturnType<typeof fixture>, beforeGit?: () => Promise<void>): CommandRunner {
	return async (command, args) => {
		await beforeGit?.();
		if (!fs.existsSync(f.worktree)) throw new Error("workspace was removed");
		if (command !== "git") throw new Error(`Unexpected ${command}`);
		if (args.includes("--show-toplevel")) return { stdout: f.worktree, stderr: "" };
		if (args.includes("--absolute-git-dir"))
			return { stdout: path.join(f.primary, ".git/worktrees/topic"), stderr: "" };
		if (args.includes("--git-common-dir")) return { stdout: path.join(f.primary, ".git"), stderr: "" };
		if (args[0] === "status") return { stdout: "", stderr: "" };
		throw new Error(`Unexpected git ${args.join(" ")}`);
	};
}

const launchOptions = (f: ReturnType<typeof fixture>, run: CommandRunner) => ({
	mode: "worktree" as const,
	cwd: f.worktree,
	agent: "worker",
	id: "new-run",
	run,
});

describe("worktree lifecycle coordination", () => {
	it("re-reads a stale cleanup snapshot after another parent reserves a workspace", async () => {
		const f = fixture();
		await terminalEntry(f);
		const other = new WorktreeLedger(path.join(f.base, "state", "worktrees.json"), f.now);
		const entered = gate();
		const release = gate();
		const snapshot = gate();
		const entries = f.ledger.entries.bind(f.ledger);
		vi.spyOn(f.ledger, "entries").mockImplementationOnce(async () => {
			const result = await entries();
			snapshot.resolve();
			return result;
		});
		const preparation = other.prepareWorkspace(
			launchOptions(
				f,
				linkedRunner(f, async () => {
					entered.resolve();
					await release.promise;
				}),
			),
		);
		await entered.promise;
		const wt = runner(f.primary, [item(f.worktree)]);
		const cleanup = reapIntegratedWorktrees({ ledger: f.ledger, run: wt.run, busy: () => false, now: f.now });
		await snapshot.promise;
		release.resolve();
		await preparation;
		const result = await cleanup;
		expect(result.removed).toEqual([]);
		expect(result.retained).toEqual([{ path: f.worktree, reason: "agent still running" }]);
		expect(wt.removals()).toEqual([]);
		expect((await other.entries())[0]?.runs).toContainEqual({
			id: "new-run",
			status: "running",
			recordedAt: f.now(),
		});
	});

	it("does not prepare or spawn into a workspace while another parent is removing it", async () => {
		const f = fixture();
		await terminalEntry(f);
		const other = new WorktreeLedger(path.join(f.base, "state", "worktrees.json"), f.now);
		const listing = gate();
		const release = gate();
		const wt = runner(f.primary, [item(f.worktree)]);
		const cleanup = reapIntegratedWorktrees({
			ledger: f.ledger,
			busy: () => false,
			now: f.now,
			run: async (command, args, cwd) => {
				if (args.includes("list")) {
					listing.resolve();
					await release.promise;
				}
				if (args.includes("remove")) fs.rmSync(f.worktree, { recursive: true });
				return wt.run(command, args, cwd);
			},
		});
		await listing.promise;
		const prepare = vi.fn(linkedRunner(f));
		const preparation = other.prepareWorkspace(launchOptions(f, prepare));
		const rejection = expect(preparation).rejects.toThrow("workspace was removed");
		expect(prepare).not.toHaveBeenCalled();
		release.resolve();
		expect((await cleanup).removed).toEqual([f.worktree]);
		await rejection;
		expect(await other.entries()).toEqual([]);
	});

	it("fails workspace preparation when its safety reservation cannot be persisted", async () => {
		const f = fixture();
		fs.mkdirSync(path.join(f.base, "state"));
		fs.writeFileSync(path.join(f.base, "state/worktrees.json"), "broken");
		await expect(f.ledger.prepareWorkspace(launchOptions(f, linkedRunner(f)))).rejects.toThrow(
			"ledger safely",
		);
	});

	it("does not acquire tracking state for inherited workspaces", async () => {
		const f = fixture();
		await expect(
			f.ledger.prepareWorkspace({ mode: "inherit", cwd: f.worktree, agent: "worker", id: "new-run" }),
		).resolves.toMatchObject({ mode: "inherit" });
		expect(fs.existsSync(path.join(f.base, "state"))).toBe(false);
	});

	it("pins schema 1 even when the user selects schema 2", async () => {
		const f = fixture();
		await terminalEntry(f);
		const wt = runner(f.primary, [item(f.worktree)]);
		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			busy: () => false,
			now: f.now,
			run: (command, args, cwd) => {
				if (args.includes("list") && !args.includes("list.json-schema=1")) {
					return Promise.resolve({ stdout: JSON.stringify({ schema: 2, items: [] }), stderr: "" });
				}
				return wt.run(command, args, cwd);
			},
		});
		expect(result.removed).toEqual([f.worktree]);
		expect(wt.calls[0]).toEqual([
			"wt",
			"-C",
			f.worktree,
			"--config-set",
			"list.json-schema=1",
			"list",
			"--format",
			"json",
		]);
	});

	it("fails closed on malformed listing elements", async () => {
		const f = fixture();
		await terminalEntry(f);
		const run = vi.fn(async () => ({ stdout: "[null]", stderr: "" }));
		const result = await reapIntegratedWorktrees({ ledger: f.ledger, run, busy: () => false, now: f.now });
		expect(result.removed).toEqual([]);
		expect(result.retained[0]?.reason).toContain("Unrecognized Worktrunk listing schema");
		expect(run).toHaveBeenCalledTimes(1);
	});
});

describe("legacy worktree adoption", () => {
	it("discovers only untracked linked worktrees with generated agent branch names", async () => {
		const f = fixture();
		const tracked = path.join(f.base, "tracked");
		await f.ledger.record(tracked, "tracked-run", true);
		const wt = runner(f.primary, [
			item(f.worktree, { branch: "pi-agent/worker-abcd1234" }),
			item(tracked, { branch: "pi-agent/worker-12345678" }),
			item("/unrelated", { branch: "feature/user-work" }),
			item("/not-generated", { branch: "pi-agent/custom" }),
			item("/detached", { branch: null, worktree: { detached: true } }),
			item("/primary", { branch: "pi-agent/worker-11223344", is_main: true }),
		]);
		expect(await discoverLegacyWorktrees({ ledger: f.ledger, run: wt.run, cwd: f.primary })).toEqual([
			f.worktree,
		]);
		expect((await f.ledger.entries()).map((entry) => entry.path)).toEqual([tracked]);
		expect(wt.removals()).toEqual([]);
	});

	it("adopts confirmed paths without overwriting a newly active run", async () => {
		const f = fixture();
		await f.ledger.adopt([f.worktree]);
		await f.ledger.record(f.worktree, "active", false);
		await f.ledger.adopt([f.worktree]);
		const wt = runner(f.primary, [item(f.worktree)]);
		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});
		expect(result.retained[0]?.reason).toBe("agent still running");
		expect((await f.ledger.entries())[0]?.runs).toEqual([
			{ id: "active", status: "running", recordedAt: f.now() },
		]);
	});

	it("cleans an adopted legacy worktree only after the same safety checks", async () => {
		const f = fixture();
		await f.ledger.adopt([f.worktree]);
		const wt = runner(f.primary, [item(f.worktree)]);
		const result = await reapIntegratedWorktrees({
			ledger: f.ledger,
			run: wt.run,
			busy: () => false,
			now: f.now,
		});
		expect(result.removed).toEqual([f.worktree]);
	});
});

describe("busy worktree detection", () => {
	it.runIf(process.platform === "linux")(
		"sees processes working inside a directory, and none in an unused one",
		() => {
			const f = fixture();

			expect(processInside(fs.realpathSync(process.cwd()))).toBe(true);
			expect(processInside(f.worktree)).toBe(false);
		},
	);
});

describe("agent worktree ledger", () => {
	it("persists runs per worktree privately and marks them terminal", async () => {
		const f = fixture();
		await f.ledger.record(f.worktree, "one", false);
		await f.ledger.record(f.worktree, "two", true);
		await f.ledger.markTerminal("one");

		const [entry] = await f.ledger.entries();
		expect(entry).toMatchObject({ path: f.worktree, created: true });
		expect(entry?.runs.map((run) => [run.id, run.status])).toEqual([
			["one", "terminal"],
			["two", "running"],
		]);
		expect(fs.statSync(path.join(f.base, "state", "worktrees.json")).mode & 0o777).toBe(0o600);
	});

	it("never evicts active reservations when terminal history reaches its cap", async () => {
		const f = fixture();
		await f.ledger.record(f.worktree, "long-running", true);
		for (let i = 0; i < 51; i++) {
			await f.ledger.record(f.worktree, `short-${i}`, false);
			await f.ledger.markTerminal(`short-${i}`);
		}
		expect((await f.ledger.entries())[0]?.runs).toContainEqual({
			id: "long-running",
			status: "running",
			recordedAt: f.now(),
		});
	});

	it("refuses a corrupt ledger instead of treating it as empty", async () => {
		const f = fixture();
		fs.mkdirSync(path.join(f.base, "state"), { recursive: true });
		fs.writeFileSync(path.join(f.base, "state", "worktrees.json"), "{not json");

		await expect(f.ledger.entries()).rejects.toThrow(/ledger safely/);
	});

	it("summarizes removals and retentions in bounded text", () => {
		const text = formatReapResult({
			removed: ["/a"],
			retained: Array.from({ length: 12 }, (_, index) => ({
				path: `/k${index}`,
				reason: "agent still running",
			})),
		});

		expect(text.split("\n")[0]).toBe("Removed 1 integrated agent worktree.");
		expect(text).toContain("- kept /k9: agent still running");
		expect(text).not.toContain("/k10");
		expect(text).toContain("- 2 more not shown");
	});
});

describe("model-facing workspace summary", () => {
	it("tells the parent that worktree cleanup is automatic, in one short line", () => {
		const text = workspaceResultText({
			mode: "worktree",
			cwd: "/w",
			branch: "pi-agent/worker-abc",
			created: true,
			linkedWorktree: true,
			setup: "no_pre_start_hook",
		});

		expect(text.split("\n").at(-1)).toBe("cleanup: automatic once integrated and clean");
	});

	it("adds nothing for inherited workspaces", () => {
		expect(
			workspaceResultText({
				mode: "inherit",
				cwd: "/w",
				created: false,
				linkedWorktree: false,
				setup: "not_applicable",
			}),
		).toBe("inherited cwd");
	});
});
