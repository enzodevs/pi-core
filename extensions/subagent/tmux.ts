import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export interface TmuxObserver {
	status(text: string): void;
	close(): void;
}

export type CommandRunner = (command: string, args: string[]) => string;

const nullObserver: TmuxObserver = {
	status() {},
	close() {},
};

function defaultRun(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export function isTmuxObservationAvailable(
	env: NodeJS.ProcessEnv = process.env,
	run: CommandRunner = defaultRun,
): boolean {
	if (!env.TMUX || !env.TMUX_PANE) return false;
	try {
		run("tmux", ["-V"]);
		return true;
	} catch {
		return false;
	}
}

export function createTmuxObserver(params: {
	id: string;
	agent: string;
	env?: NodeJS.ProcessEnv;
	run?: CommandRunner;
	tempRoot?: string;
}): TmuxObserver {
	const env = params.env ?? process.env;
	const run = params.run ?? defaultRun;
	if (!isTmuxObservationAvailable(env, run)) return nullObserver;

	let directory: string | undefined;
	let pane: string | undefined;
	try {
		directory = fs.mkdtempSync(path.join(params.tempRoot ?? os.tmpdir(), "pi-core-agent-view-"));
		const logFile = path.join(directory, "status.log");
		fs.writeFileSync(logFile, `${params.id} ${params.agent} starting\n`, { encoding: "utf8", mode: 0o600 });
		pane = run("tmux", [
			"split-window",
			"-d",
			"-h",
			"-t",
			env.TMUX_PANE as string,
			"-P",
			"-F",
			"#{pane_id}",
			"tail",
			"-n",
			"+1",
			"-f",
			"--",
			logFile,
		]).trim();
		if (!pane.startsWith("%")) throw new Error("tmux did not return a pane id");
		run("tmux", ["select-pane", "-t", pane, "-T", `agent:${params.agent}:${params.id}`]);

		let closed = false;
		return {
			status(text: string) {
				if (closed) return;
				const line = text
					.replace(/[\r\n]+/g, " ")
					.trim()
					.slice(0, 240);
				try {
					fs.appendFileSync(logFile, `${line}\n`, "utf8");
				} catch {
					// Observation is best effort and never affects RPC supervision.
				}
			},
			close() {
				if (closed) return;
				closed = true;
				try {
					run("tmux", ["kill-pane", "-t", pane as string]);
				} catch {
					// The user may already have closed the pane.
				}
				try {
					fs.rmSync(directory as string, { recursive: true, force: true });
				} catch {
					// Temporary status cleanup is best effort.
				}
			},
		};
	} catch {
		if (pane) {
			try {
				run("tmux", ["kill-pane", "-t", pane]);
			} catch {
				// Ignore optional display failures.
			}
		}
		if (directory) fs.rmSync(directory, { recursive: true, force: true });
		return nullObserver;
	}
}
