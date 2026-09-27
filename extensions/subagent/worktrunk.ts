import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

const MAX_COMMAND_OUTPUT = 64 * 1024;
const COMMAND_TIMEOUT_MS = 10 * 60 * 1000;
const DEPENDENCY_DIRS = ["vendor", "node_modules", ".venv"] as const;

export type WorkspaceMode = "inherit" | "worktree";
export type WorkspaceSetup =
	| "not_applicable"
	| "pre_start_completed"
	| "no_pre_start_hook"
	| "existing_worktree";

export interface WorktreeWorkspace {
	mode: WorkspaceMode;
	cwd: string;
	branch?: string;
	created: boolean;
	linkedWorktree: boolean;
	setup: WorkspaceSetup;
}

export interface CommandResult {
	stdout: string;
	stderr: string;
}

export type CommandRunner = (command: string, args: string[], cwd: string) => Promise<CommandResult>;

interface WorktrunkHook {
	type: string;
	source: "user" | "project";
	template: string;
	needs_approval: boolean;
	name?: string | null;
}

export async function readWorktrunkHooks(
	cwd: string,
	run: CommandRunner,
	phase?: string,
): Promise<WorktrunkHook[]> {
	const result = await run(
		"wt",
		["-C", cwd, "hook", "show", ...(phase ? [phase] : []), "--format", "json"],
		cwd,
	);
	const hooks: unknown = JSON.parse(result.stdout);
	if (
		!Array.isArray(hooks) ||
		hooks.some(
			(hook) =>
				!hook ||
				typeof hook.type !== "string" ||
				(phase !== undefined && hook.type !== phase) ||
				typeof hook.template !== "string" ||
				!["user", "project"].includes(hook.source) ||
				typeof hook.needs_approval !== "boolean",
		)
	) {
		throw new Error("Unrecognized Worktrunk hook metadata; refusing unattended execution.");
	}
	return hooks as WorktrunkHook[];
}

export function defaultCommandRunner(command: string, args: string[], cwd: string): Promise<CommandResult> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		let settled = false;
		const timer = setTimeout(() => {
			child.kill("SIGTERM");
			finish(new Error(`${command} timed out after ${COMMAND_TIMEOUT_MS}ms.`));
		}, COMMAND_TIMEOUT_MS);
		const finish = (error?: Error) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			if (error) reject(error);
			else resolve({ stdout, stderr });
		};
		const append = (current: string, chunk: Buffer) => {
			const next = current + chunk.toString("utf8");
			if (Buffer.byteLength(next, "utf8") > MAX_COMMAND_OUTPUT) {
				child.kill("SIGTERM");
				finish(new Error(`${command} produced more than ${MAX_COMMAND_OUTPUT} bytes.`));
			}
			return next;
		};
		child.stdout.on("data", (chunk: Buffer) => {
			stdout = append(stdout, chunk);
		});
		child.stderr.on("data", (chunk: Buffer) => {
			stderr = append(stderr, chunk);
		});
		child.on("error", (error) => finish(error));
		// Wait for stdout/stderr to drain; exit can precede the final Git/Worktrunk output.
		child.on("close", (code, signal) => {
			if (code === 0) finish();
			else finish(new Error(`${command} failed (${signal ?? code}): ${stderr.trim() || "no error output"}`));
		});
	});
}

async function gitValue(cwd: string, args: string[], run: CommandRunner): Promise<string> {
	return (await run("git", ["rev-parse", ...args], cwd)).stdout.trim();
}

function parseWorktreePath(output: string, branch: string): string | null {
	let candidate: string | null = null;
	for (const block of output.split(/\n\n+/)) {
		const lines = block.split("\n");
		if (!lines.includes(`branch refs/heads/${branch}`)) continue;
		const worktree = lines.find((line) => line.startsWith("worktree "));
		if (worktree) candidate = worktree.slice("worktree ".length);
	}
	return candidate;
}

function assertDependencyIsolation(worktreeRoot: string): void {
	const normalizedRoot = `${fs.realpathSync(worktreeRoot)}${path.sep}`;
	for (const directory of DEPENDENCY_DIRS) {
		const candidate = path.join(worktreeRoot, directory);
		if (!fs.existsSync(candidate)) continue;
		const resolved = fs.realpathSync(candidate);
		if (`${resolved}${path.sep}`.startsWith(normalizedRoot)) continue;
		throw new Error(
			`Unsafe shared dependency directory: ${directory} resolves outside the Worktrunk worktree. Configure a blocking Worktrunk pre-start hook to install dependencies inside each worktree.`,
		);
	}
}

export function worktreeBranch(agent: string, id: string): string {
	const safeAgent =
		agent
			.toLowerCase()
			.replace(/[^a-z0-9-]+/g, "-")
			.replace(/^-+|-+$/g, "") || "agent";
	return `pi-agent/${safeAgent}-${id}`;
}

export async function prepareWorkspace(options: {
	mode: WorkspaceMode;
	cwd: string;
	agent: string;
	id: string;
	run?: CommandRunner;
}): Promise<WorktreeWorkspace> {
	if (options.mode === "inherit") {
		return {
			mode: "inherit",
			cwd: options.cwd,
			created: false,
			linkedWorktree: false,
			setup: "not_applicable",
		};
	}
	const run = options.run ?? defaultCommandRunner;
	let root: string;
	let gitDir: string;
	let commonDir: string;
	try {
		[root, gitDir, commonDir] = await Promise.all([
			gitValue(options.cwd, ["--show-toplevel"], run),
			gitValue(options.cwd, ["--absolute-git-dir"], run),
			gitValue(options.cwd, ["--path-format=absolute", "--git-common-dir"], run),
		]);
	} catch (error) {
		throw new Error(
			`Worktree workspace requires a Git repository: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
	const status = (await run("git", ["status", "--porcelain"], root)).stdout.trim();
	if (status) {
		throw new Error(
			"Cannot launch a worktree-isolated agent from a dirty checkout. Commit/stash the changes or set workspace to inherit explicitly.",
		);
	}
	if (path.resolve(gitDir) !== path.resolve(commonDir)) {
		assertDependencyIsolation(root);
		return {
			mode: "worktree",
			cwd: root,
			created: false,
			linkedWorktree: true,
			setup: "existing_worktree",
		};
	}
	const branch = worktreeBranch(options.agent, options.id);
	let hookConfigured: boolean;
	try {
		const hooks = await readWorktrunkHooks(root, run);
		if (hooks.some((hook) => hook.needs_approval)) {
			throw new Error(
				"Worktrunk hooks need user approval. Review wt hook show and approve with wt config approvals add before launching a worktree agent.",
			);
		}
		hookConfigured = hooks.some((hook) => hook.type === "pre-start");
		await run("wt", ["-C", root, "switch", "--create", branch, "--base", "HEAD"], root);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (/ENOENT|not found|spawn wt/i.test(message)) {
			throw new Error("Worktrunk (`wt`) is required for worktree agents but was not found on PATH.");
		}
		throw new Error(`Worktrunk could not create ${branch}: ${message}`);
	}
	const listing = await run("git", ["worktree", "list", "--porcelain"], root);
	const worktreeRoot = parseWorktreePath(listing.stdout, branch);
	if (!worktreeRoot)
		throw new Error(`Worktrunk created ${branch}, but Git did not report its worktree path.`);
	assertDependencyIsolation(worktreeRoot);
	return {
		mode: "worktree",
		cwd: worktreeRoot,
		branch,
		created: true,
		linkedWorktree: true,
		setup: hookConfigured ? "pre_start_completed" : "no_pre_start_hook",
	};
}
