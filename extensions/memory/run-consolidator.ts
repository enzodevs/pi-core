import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, openSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	CONSOLIDATION_MODEL,
	CONSOLIDATION_PROVIDER,
	CONSOLIDATION_THINKING,
	consolidationPrompt,
	firstPendingJob,
	type JournalJob,
} from "./consolidator.ts";

interface MemoryRoot {
	path?: string;
}

function jsonCommand(args: string[]): unknown {
	return JSON.parse(execFileSync("agent-memory", args, { encoding: "utf8", timeout: 10_000 }));
}

function oldestPendingJob(): JournalJob | undefined {
	const roots = jsonCommand(["roots", "--json"]);
	if (!Array.isArray(roots)) return;
	const pending: JournalJob[] = [];
	for (const root of roots as MemoryRoot[]) {
		if (!root.path) continue;
		try {
			execFileSync("agent-memory", ["--root", root.path, "maintenance", "reconcile", "--json"], {
				stdio: "ignore",
				timeout: 10_000,
			});
			const listed = jsonCommand(["--root", root.path, "journal", "list", "--status", "pending", "--json"]);
			const job = firstPendingJob(JSON.stringify(listed));
			if (job) pending.push({ ...job, memory_root: root.path });
		} catch {}
	}
	return pending.sort((left, right) =>
		String(left.created_at ?? "").localeCompare(String(right.created_at ?? "")),
	)[0];
}

const job = oldestPendingJob();
if (!job) process.exit(0);
const cwd = job.project ?? process.cwd();
const stateDir = path.join(os.homedir(), ".pi", "agent", "pi-core");
mkdirSync(stateDir, { recursive: true, mode: 0o700 });
const logFd = openSync(path.join(stateDir, "memory-consolidator.log"), "w", 0o600);
const result = spawnSync(
	"pi",
	[
		"--no-session",
		"--mode",
		"text",
		"--model",
		`${CONSOLIDATION_PROVIDER}/${CONSOLIDATION_MODEL}`,
		"--thinking",
		CONSOLIDATION_THINKING,
		"--tools",
		"read,bash",
		"--append-system-prompt",
		path.join(import.meta.dirname, "consolidator-system.md"),
		"-p",
		consolidationPrompt(job, cwd),
	],
	{
		cwd,
		env: { ...process.env, PI_CORE_MEMORY_CONSOLIDATOR: "1" },
		stdio: ["ignore", logFd, logFd],
		timeout: 15 * 60_000,
	},
);
process.exit(result.status ?? 1);
