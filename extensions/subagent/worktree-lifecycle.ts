import { createHash, randomBytes } from "node:crypto";
import * as path from "node:path";
import { ProcessLogStore } from "../background-process/log-store.ts";
import { type ProcessResult, runBackgroundProcess } from "../background-process/process.ts";
import { truncateUtf8 } from "./limits.ts";
import type { WorktreeLedger } from "./worktree-reaper.ts";
import { type CommandRunner, defaultCommandRunner, readWorktrunkHooks } from "./worktrunk.ts";

interface WorkspaceSnapshot {
	head: string;
	branch: string;
	repository: string;
	target: string;
	targetHead: string;
	targetCwd: string;
}

export interface WorktreeVerification {
	state: "checking" | "passed" | "blocked" | "failed" | "interrupted";
	summary: string;
	checkedAt?: number;
	workspace?: WorkspaceSnapshot;
	hooksHash?: string;
	logPath?: string;
}

export interface WorktreeIntegration {
	state: "integrating" | "integrated" | "failed" | "interrupted";
	head: string;
	target: string;
	summary: string;
}

interface CheckResult extends Pick<ProcessResult, "status" | "exitCode"> {
	logPath: string;
}

type CheckRunner = (cwd: string, signal?: AbortSignal) => Promise<CheckResult>;

class VerificationBlocked extends Error {}

function errorText(error: unknown): string {
	return truncateUtf8(error instanceof Error ? error.message : String(error), 1024);
}

function checkRunner(logRoot: string): CheckRunner {
	return async (cwd, signal) => {
		signal?.throwIfAborted();
		const id = randomBytes(4).toString("hex");
		const log = new ProcessLogStore({ root: logRoot }).create(id);
		let stop = () => {};
		const abort = () => stop();
		try {
			const result = await runBackgroundProcess({
				// Fixed command: no task text, paths, or model-provided shell fragments.
				command: "wt hook pre-merge --foreground",
				cwd,
				mode: "wait",
				timeoutSeconds: 600,
				log,
				onSpawn(handle) {
					stop = handle.stop;
					signal?.addEventListener("abort", abort, { once: true });
					if (signal?.aborted) stop();
				},
			});
			return { status: result.status, exitCode: result.exitCode, logPath: path.join(logRoot, `${id}.log`) };
		} finally {
			log.close();
			signal?.removeEventListener("abort", abort);
		}
	};
}

/** Owns verification receipts and exact-commit integration policy, independent of Pi event wiring. */
export class WorktreeLifecycle {
	private readonly run: CommandRunner;
	private readonly check: CheckRunner;

	constructor(
		private readonly options: {
			ledger: WorktreeLedger;
			logRoot: string;
			run?: CommandRunner;
			check?: CheckRunner;
		},
	) {
		this.run = options.run ?? defaultCommandRunner;
		this.check = options.check ?? checkRunner(options.logRoot);
	}

	async verify(cwd: string, runId: string, signal?: AbortSignal): Promise<WorktreeVerification> {
		let logPath: string | undefined;
		try {
			return await this.options.ledger.withIdleWorktree(
				cwd,
				runId,
				async () => {
					signal?.throwIfAborted();
					const workspace = await this.snapshot(cwd);
					const hooksHash = await this.approvedHooks(cwd);
					signal?.throwIfAborted();
					const result = await this.check(cwd, signal);
					logPath = result.logPath;
					if (signal?.aborted || result.status === "stopped") {
						return { state: "interrupted", summary: "Verification cancelled; run verify again.", logPath };
					}
					if (result.status !== "complete") {
						return {
							state: "failed",
							summary: `Pre-merge checks ${result.status} (exit ${result.exitCode ?? "unknown"}).`,
							logPath,
						};
					}
					const after = await this.snapshot(cwd);
					if (
						JSON.stringify(after) !== JSON.stringify(workspace) ||
						(await this.approvedHooks(cwd)) !== hooksHash
					) {
						throw new VerificationBlocked(
							"Workspace, target, or hooks changed during verification; run verify again.",
						);
					}
					signal?.throwIfAborted();
					return {
						state: "passed",
						summary: "Approved pre-merge checks passed; ready for review.",
						workspace,
						hooksHash,
						checkedAt: Date.now(),
						logPath,
					};
				},
				signal,
			);
		} catch (error) {
			return {
				state: signal?.aborted ? "interrupted" : error instanceof VerificationBlocked ? "blocked" : "failed",
				summary: errorText(error),
				logPath,
			};
		}
	}

	async integrate(
		cwd: string,
		runId: string,
		verification: WorktreeVerification | undefined,
		revision: string,
		signal?: AbortSignal,
	): Promise<WorktreeIntegration> {
		const verified = verification?.workspace;
		if (
			verification?.state !== "passed" ||
			!verified ||
			!verification.hooksHash ||
			revision !== verified.head
		) {
			throw new Error(
				"Integration requires passed verification and the exact reviewed revision from its receipt.",
			);
		}
		const integrated = (summary: string): WorktreeIntegration => ({
			state: "integrated",
			head: revision,
			target: verified.target,
			summary,
		});
		try {
			signal?.throwIfAborted();
			// Reconcile a successful merge whose acknowledgement was lost, including after cleanup.
			if (await this.containsRevision(verified))
				return integrated("Verified revision is already integrated locally.");
			return await this.options.ledger.withIdleWorktree(
				cwd,
				runId,
				async () => {
					signal?.throwIfAborted();
					const current = await this.snapshot(cwd);
					if (
						JSON.stringify(current) !== JSON.stringify(verified) ||
						(await this.approvedHooks(cwd)) !== verification.hooksHash
					) {
						throw new Error(
							"Verification is stale: workspace, target, or hooks changed. Run verify and review again.",
						);
					}
					const targetBranch = (
						await this.run("git", ["symbolic-ref", "--short", "HEAD"], current.targetCwd)
					).stdout.trim();
					if (targetBranch !== current.target)
						throw new Error("Target checkout changed branches; refusing integration.");
					if (
						(
							await this.run("git", ["status", "--porcelain", "--untracked-files=all"], current.targetCwd)
						).stdout.trim()
					) {
						throw new Error("Target worktree is dirty; commit or stash its changes before integration.");
					}
					// Require ancestry before invoking merge: never leave a conflicted merge/rebase behind.
					try {
						await this.run("git", ["merge-base", "--is-ancestor", current.targetHead, revision], cwd);
					} catch (error) {
						throw new Error(
							`Cannot establish a safe fast-forward. Reconcile the source with the target, then verify and review again. ${errorText(error)}`,
						);
					}
					signal?.throwIfAborted();
					// Worktrunk's merge pipeline can commit/rewrite, and step push consumes a moving branch.
					// Git's immutable SHA argument integrates only the reviewed code. Worktrunk still owns
					// setup, approved verification hooks and cleanup. This never publishes to a remote.
					await this.run("git", ["merge", "--ff-only", "--no-edit", revision], current.targetCwd);
					if (!(await this.containsRevision(verified)))
						throw new Error("Could not confirm the target contains the verified revision.");
					return integrated("Verified revision integrated locally; safe worktree cleanup is scheduled.");
				},
				signal,
			);
		} catch (error) {
			// A Git hook/transport failure after the ref update must not invite a duplicate merge.
			if (await this.containsRevision(verified))
				return integrated("Local integration confirmed after an interrupted acknowledgement.");
			return {
				state: signal?.aborted ? "interrupted" : "failed",
				head: revision,
				target: verified.target,
				summary: errorText(error),
			};
		}
	}

	private async containsRevision(workspace: WorkspaceSnapshot): Promise<boolean> {
		try {
			await this.run(
				"git",
				[
					"--git-dir",
					workspace.repository,
					"merge-base",
					"--is-ancestor",
					workspace.head,
					`refs/heads/${workspace.target}`,
				],
				workspace.repository,
			);
			return true;
		} catch {
			return false;
		}
	}

	private async snapshot(cwd: string): Promise<WorkspaceSnapshot> {
		const git = async (args: string[]) => (await this.run("git", args, cwd)).stdout.trim();
		const repository = await git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
		const gitDir = await git(["rev-parse", "--absolute-git-dir"]);
		if (path.resolve(repository) === path.resolve(gitDir))
			throw new VerificationBlocked("Only linked worktrees can use the managed integration lifecycle.");
		if (await git(["status", "--porcelain", "--untracked-files=all"]))
			throw new VerificationBlocked(
				"Worktree is dirty. Commit completed changes before verification; the harness never auto-commits.",
			);
		const branch = await git(["symbolic-ref", "--short", "HEAD"]);
		const head = await git(["rev-parse", "--verify", "HEAD"]);
		const target = (await this.run("wt", ["config", "state", "default-branch"], cwd)).stdout.trim();
		if (!target || target === branch)
			throw new VerificationBlocked("A distinct Worktrunk default branch is required for integration.");
		await git(["check-ref-format", `refs/heads/${target}`]);
		const targetHead = await git(["rev-parse", "--verify", `refs/heads/${target}^{commit}`]);
		const listing = (await this.run("git", ["worktree", "list", "--porcelain", "-z"], cwd)).stdout;
		let worktreePath = "";
		const targets: string[] = [];
		for (const field of listing.split("\0")) {
			if (field.startsWith("worktree ")) worktreePath = field.slice(9);
			if (field === `branch refs/heads/${target}`) targets.push(worktreePath);
		}
		if (targets.length !== 1 || !path.isAbsolute(targets[0] ?? ""))
			throw new VerificationBlocked(
				"The default branch must have exactly one existing checkout for managed integration.",
			);
		return { head, branch, repository, target, targetHead, targetCwd: targets[0] as string };
	}

	private async approvedHooks(cwd: string): Promise<string> {
		const hooks = await readWorktrunkHooks(cwd, this.run, "pre-merge");
		if (hooks.length === 0)
			throw new VerificationBlocked(
				"No pre-merge checks configured. Configure Worktrunk pre-merge hooks, approve them, then run verify.",
			);
		for (const hook of hooks) {
			if (hook.needs_approval)
				throw new VerificationBlocked(
					"Pre-merge hooks need user approval. Review them with wt hook show, approve through wt config approvals add, then run verify.",
				);
		}
		return createHash("sha256").update(JSON.stringify(hooks)).digest("hex");
	}
}

export function normalizeVerification(value: unknown): WorktreeVerification | undefined {
	if (!value || typeof value !== "object") return undefined;
	const receipt = value as WorktreeVerification;
	if (
		!["checking", "passed", "blocked", "failed", "interrupted"].includes(receipt.state) ||
		typeof receipt.summary !== "string"
	)
		return undefined;
	if (receipt.state === "passed") {
		const workspace = receipt.workspace;
		if (
			!workspace ||
			!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(workspace.head) ||
			!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(workspace.targetHead) ||
			typeof workspace.branch !== "string" ||
			typeof workspace.target !== "string" ||
			typeof workspace.repository !== "string" ||
			!path.isAbsolute(workspace.repository) ||
			typeof workspace.targetCwd !== "string" ||
			!path.isAbsolute(workspace.targetCwd) ||
			typeof receipt.hooksHash !== "string" ||
			!/^[a-f0-9]{64}$/.test(receipt.hooksHash)
		)
			return undefined;
	}
	return {
		...receipt,
		summary: truncateUtf8(receipt.summary, 1024),
		logPath: typeof receipt.logPath === "string" ? receipt.logPath : undefined,
	};
}

export function normalizeIntegration(value: unknown): WorktreeIntegration | undefined {
	if (!value || typeof value !== "object") return undefined;
	const receipt = value as WorktreeIntegration;
	if (
		!["integrating", "integrated", "failed", "interrupted"].includes(receipt.state) ||
		typeof receipt.summary !== "string" ||
		typeof receipt.target !== "string" ||
		typeof receipt.head !== "string"
	)
		return undefined;
	return { ...receipt, summary: truncateUtf8(receipt.summary, 1024) };
}

export function lifecycleSummary(
	verification?: WorktreeVerification,
	integration?: WorktreeIntegration,
): string {
	if (integration?.state === "integrated")
		return `integration: ${integration.head} → ${integration.target} (local)`;
	const lines: string[] = [];
	if (verification) {
		lines.push(`verification: ${verification.state} — ${verification.summary}`);
		if (verification.workspace)
			lines.push(`revision: ${verification.workspace.head}\ntarget: ${verification.workspace.target}`);
		if (verification.logPath) lines.push(`check log: ${verification.logPath}`);
	}
	if (integration) lines.push(`integration: ${integration.state} — ${integration.summary}`);
	return truncateUtf8(lines.join("\n"), 2048);
}
