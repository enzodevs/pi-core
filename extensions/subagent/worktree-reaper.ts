import * as fs from "node:fs";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import lockfile from "proper-lockfile";
import { type CommandRunner, prepareWorkspace, type WorktreeWorkspace } from "./worktrunk.ts";

/** A run still marked running after this long is treated as abandoned by a crashed parent. */
const ABANDONED_RUN_MS = 24 * 60 * 60 * 1000;
const MAX_RUNS_PER_ENTRY = 50;
/** Worktrunk states in which merging the branch would add nothing to the default branch. */
const INTEGRATED_STATES = new Set(["integrated", "empty"]);
const WORKING_TREE_FLAGS = ["staged", "modified", "untracked", "renamed", "deleted"] as const;

export interface WorktreeLedgerRun {
	id: string;
	status: "running" | "terminal";
	recordedAt: number;
}

export interface WorktreeLedgerEntry {
	path: string;
	created: boolean;
	runs: WorktreeLedgerRun[];
}

interface LedgerState {
	version: 1;
	entries: WorktreeLedgerEntry[];
}

export interface ReapResult {
	removed: string[];
	retained: { path: string; reason: string }[];
}

interface WorktrunkItem {
	branch?: string | null;
	path?: string;
	is_main?: boolean;
	main_state?: string;
	worktree?: { detached?: boolean };
	working_tree?: Partial<Record<(typeof WORKING_TREE_FLAGS)[number], boolean>>;
}

function canonical(worktreePath: string): string {
	try {
		return fs.realpathSync(worktreePath);
	} catch {
		return path.resolve(worktreePath);
	}
}

/**
 * Durable record of the worktrees agents ran in, shared by every Pi process.
 * Only this ledger's entries are ever considered for removal.
 */
export class WorktreeLedger {
	private readonly filePath: string;
	private readonly now: () => number;

	constructor(filePath: string, now: () => number = Date.now) {
		this.filePath = filePath;
		this.now = now;
	}

	/** Reserve before returning a workspace to the launcher; a failed reservation must prevent spawning. */
	async prepareWorkspace(options: Parameters<typeof prepareWorkspace>[0]): Promise<WorktreeWorkspace> {
		if (options.mode === "inherit") return prepareWorkspace(options);
		return this.withLifecycleLock(async () => {
			await this.read(); // Refuse corrupt state before creating another worktree.
			const workspace = await prepareWorkspace(options);
			await this.recordUnlocked(workspace.cwd, options.id, workspace.created);
			return workspace;
		});
	}

	async record(worktreePath: string, runId: string, created: boolean): Promise<void> {
		await this.withLifecycleLock(() => this.recordUnlocked(worktreePath, runId, created));
	}

	private async recordUnlocked(worktreePath: string, runId: string, created: boolean): Promise<void> {
		const key = canonical(worktreePath);
		await this.update((entries) => {
			let entry = entries.find((candidate) => candidate.path === key);
			if (!entry) {
				entry = { path: key, created, runs: [] };
				entries.push(entry);
			}
			entry.created ||= created;
			const prior = entry.runs.filter((run) => run.id !== runId);
			entry.runs = [
				...prior.filter((run) => run.status === "terminal").slice(-MAX_RUNS_PER_ENTRY),
				...prior.filter((run) => run.status === "running"),
				{ id: runId, status: "running" as const, recordedAt: this.now() },
			];
		});
	}

	async markTerminal(runId: string): Promise<void> {
		await this.update((entries) => {
			for (const entry of entries) {
				for (const run of entry.runs) if (run.id === runId) run.status = "terminal";
			}
		});
	}

	async entries(): Promise<WorktreeLedgerEntry[]> {
		return (await this.read()).entries;
	}

	/** Hold workspace ownership across verification/integration as well as cleanup. */
	async withIdleWorktree<T>(
		worktreePath: string,
		runId: string,
		operation: () => Promise<T>,
		signal?: AbortSignal,
	): Promise<T> {
		return this.withLifecycleLock(async () => {
			const entry = (await this.entries()).find((candidate) => candidate.path === canonical(worktreePath));
			if (!entry?.runs.some((run) => run.id === runId && run.status === "terminal")) {
				throw new Error("Worktree has no terminal reservation for this run.");
			}
			if (
				entry.runs.some((run) => run.status === "running" && this.now() - run.recordedAt < ABANDONED_RUN_MS)
			) {
				throw new Error("Another agent is still using this worktree.");
			}
			return operation();
		}, signal);
	}

	/** Re-read under the same cross-process lock used by workspace preparation and reservation. */
	async reapEntry(
		worktreePath: string,
		inspect: (entry: WorktreeLedgerEntry) => Promise<boolean>,
	): Promise<void> {
		await this.withLifecycleLock(async () => {
			const entry = (await this.entries()).find((candidate) => candidate.path === worktreePath);
			if (entry && (await inspect(entry))) await this.drop([entry.path]);
		});
	}

	/** Only explicitly confirmed legacy paths are adopted; existing active runs are never overwritten. */
	async adopt(worktreePaths: readonly string[]): Promise<void> {
		await this.withLifecycleLock(() =>
			this.update((entries) => {
				for (const worktreePath of worktreePaths) {
					const key = canonical(worktreePath);
					if (!entries.some((entry) => entry.path === key)) {
						entries.push({ path: key, created: false, runs: [] });
					}
				}
			}),
		);
	}

	private async withLifecycleLock<T>(operation: () => Promise<T>, signal?: AbortSignal): Promise<T> {
		signal?.throwIfAborted();
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		// Keep state writes short and independently available to terminal callbacks. Retry the
		// lifecycle lock with an abortable timer so reload/stop never waits out another parent's job.
		const deadline = Date.now() + 10 * 60 * 1000;
		let release: (() => Promise<void>) | undefined;
		while (!release) {
			signal?.throwIfAborted();
			try {
				release = await lockfile.lock(`${this.filePath}.lifecycle`, {
					realpath: false,
					stale: 30_000,
					retries: 0,
				});
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ELOCKED" || Date.now() >= deadline) throw error;
				await delay(100, undefined, { signal });
			}
		}
		try {
			signal?.throwIfAborted();
			return await operation();
		} finally {
			await release();
		}
	}

	private async drop(paths: readonly string[]): Promise<void> {
		if (paths.length === 0) return;
		const dropped = new Set(paths);
		await this.update((entries) =>
			entries.splice(0, entries.length, ...entries.filter((e) => !dropped.has(e.path))),
		);
	}

	private async update(mutate: (entries: WorktreeLedgerEntry[]) => void): Promise<void> {
		await fs.promises.mkdir(path.dirname(this.filePath), { recursive: true, mode: 0o700 });
		const release = await lockfile.lock(this.filePath, {
			realpath: false,
			stale: 30_000,
			retries: { retries: 30, minTimeout: 20, maxTimeout: 500 },
		});
		try {
			const state = await this.read();
			mutate(state.entries);
			const temporary = `${this.filePath}.tmp-${process.pid}-${Math.random().toString(16).slice(2)}`;
			await fs.promises.writeFile(temporary, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
			await fs.promises.rename(temporary, this.filePath);
		} finally {
			await release();
		}
	}

	private async read(): Promise<LedgerState> {
		try {
			const parsed = JSON.parse(await fs.promises.readFile(this.filePath, "utf8")) as Partial<LedgerState>;
			if (parsed.version !== 1 || !Array.isArray(parsed.entries)) throw new Error("unexpected shape");
			const entries = parsed.entries.filter(
				(entry): entry is WorktreeLedgerEntry =>
					Boolean(entry) &&
					typeof entry.path === "string" &&
					path.isAbsolute(entry.path) &&
					typeof entry.created === "boolean" &&
					Array.isArray(entry.runs) &&
					entry.runs.every(
						(run) =>
							typeof run?.id === "string" &&
							(run.status === "running" || run.status === "terminal") &&
							Number.isFinite(run.recordedAt),
					),
			);
			if (entries.length !== parsed.entries.length) throw new Error("invalid ledger entry");
			return { version: 1, entries };
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1, entries: [] };
			throw new Error("Cannot read the agent worktree ledger safely.", { cause: error });
		}
	}
}

/** Linux: true when any process (including this one) has its working directory inside the worktree. */
export function processInside(worktreePath: string): boolean {
	let pids: string[];
	try {
		pids = fs.readdirSync("/proc").filter((name) => /^\d+$/.test(name));
	} catch {
		// Without process visibility (e.g. non-Linux hosts), automatic deletion is unsafe.
		return true;
	}
	const prefix = `${worktreePath}${path.sep}`;
	return pids.some((pid) => {
		try {
			const cwd = fs.readlinkSync(`/proc/${pid}/cwd`);
			return cwd === worktreePath || cwd.startsWith(prefix);
		} catch {
			return false;
		}
	});
}

function parseListing(stdout: string): WorktrunkItem[] | null {
	try {
		const parsed = JSON.parse(stdout) as unknown;
		return Array.isArray(parsed) && parsed.every((item) => item !== null && typeof item === "object")
			? (parsed as WorktrunkItem[])
			: null;
	} catch {
		return null;
	}
}

function retentionReason(item: WorktrunkItem): string | null {
	if (!item.working_tree || typeof item.main_state !== "string") return "unrecognized Worktrunk output";
	if (WORKING_TREE_FLAGS.some((flag) => item.working_tree?.[flag] !== false)) return "uncommitted changes";
	if (!INTEGRATED_STATES.has(item.main_state)) return `not integrated (${item.main_state})`;
	return null;
}

async function listWorktrees(run: CommandRunner, cwd: string): Promise<WorktrunkItem[]> {
	// User configuration may select schema 2, whose field layout differs. Pin the schema we parse.
	const output = await run(
		"wt",
		["-C", cwd, "--config-set", "list.json-schema=1", "list", "--format", "json"],
		cwd,
	);
	const listing = parseListing(output.stdout);
	if (!listing) throw new Error("Unrecognized Worktrunk listing schema.");
	return listing;
}

/** Read-only discovery; adoption requires explicit user confirmation in the command handler. */
export async function discoverLegacyWorktrees(options: {
	ledger: WorktreeLedger;
	run: CommandRunner;
	cwd: string;
}): Promise<string[]> {
	const tracked = new Set((await options.ledger.entries()).map((entry) => entry.path));
	const listing = await listWorktrees(options.run, options.cwd);
	return listing.flatMap((item) => {
		if (
			typeof item.path !== "string" ||
			!path.isAbsolute(item.path) ||
			item.is_main !== false ||
			item.worktree?.detached !== false ||
			typeof item.branch !== "string" ||
			!/^pi-agent\/[a-z0-9-]+-(?:[0-9a-f]{8}|[0-9a-f]{12})$/.test(item.branch)
		)
			return [];
		const key = canonical(item.path);
		return tracked.has(key) ? [] : [key];
	});
}

/**
 * Only integrated, clean, idle ledger worktrees are eligible. Reservation and removal share a
 * cross-process lifecycle lock. Worktrunk re-checks dirtiness and preserves a branch that moved
 * or became unintegrated; no force flags are used.
 */
export async function reapIntegratedWorktrees(options: {
	ledger: WorktreeLedger;
	run: CommandRunner;
	busy?: (worktreePath: string) => boolean;
	now?: () => number;
}): Promise<ReapResult> {
	const busy = options.busy ?? processInside;
	const now = (options.now ?? Date.now)();
	const result: ReapResult = { removed: [], retained: [] };

	for (const candidate of await options.ledger.entries()) {
		try {
			await options.ledger.reapEntry(candidate.path, async (entry) => {
				if (entry.runs.some((run) => run.status === "running" && now - run.recordedAt < ABANDONED_RUN_MS)) {
					result.retained.push({ path: entry.path, reason: "agent still running" });
					return false;
				}
				if (!fs.existsSync(entry.path)) return true;
				let listing: WorktrunkItem[];
				try {
					listing = await listWorktrees(options.run, entry.path);
				} catch (error) {
					result.retained.push({
						path: entry.path,
						reason: `wt list failed: ${String(error).slice(0, 160)}`,
					});
					return false;
				}
				const item = listing.find(
					(candidate) => typeof candidate.path === "string" && canonical(candidate.path) === entry.path,
				);
				const primary = listing.find(
					(candidate) => candidate.is_main === true && typeof candidate.path === "string",
				);
				if (!item || !primary?.path) {
					result.retained.push({ path: entry.path, reason: "not a recognized linked worktree" });
					return false;
				}
				if (item.is_main || item.worktree?.detached || !item.branch) {
					result.retained.push({ path: entry.path, reason: "primary or detached checkout" });
					return true;
				}
				const reason =
					retentionReason(item) ??
					(busy(entry.path) ? "a process is working inside or process visibility is unavailable" : null);
				if (reason) {
					result.retained.push({ path: entry.path, reason });
					return false;
				}
				try {
					await options.run("wt", ["-C", primary.path, "remove", entry.path, "--foreground"], primary.path);
					result.removed.push(entry.path);
					return true;
				} catch (error) {
					result.retained.push({
						path: entry.path,
						reason: `wt remove refused: ${String(error).slice(0, 160)}`,
					});
					return false;
				}
			});
		} catch (error) {
			result.retained.push({
				path: candidate.path,
				reason: `cleanup deferred: ${String(error).slice(0, 160)}`,
			});
		}
	}
	return result;
}

export function formatReapResult(result: ReapResult): string {
	const lines = [
		`Removed ${result.removed.length} integrated agent worktree${result.removed.length === 1 ? "" : "s"}.`,
		...result.removed.slice(0, 10).map((worktree) => `- removed ${worktree}`),
		...result.retained.slice(0, 10).map((item) => `- kept ${item.path}: ${item.reason}`),
	];
	const hidden = Math.max(0, result.removed.length - 10) + Math.max(0, result.retained.length - 10);
	if (hidden > 0) lines.push(`- ${hidden} more not shown`);
	return lines.join("\n");
}
