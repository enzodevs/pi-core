import { execFileSync } from "node:child_process";
import * as path from "node:path";

export type CommandRunner = (command: string, args: string[]) => string;

function defaultRun(command: string, args: string[]): string {
	return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
}

export interface TmuxPaneLaunch {
	parentPane: string;
	cwd: string;
	title: string;
	channelDirectory: string;
	channelToken: string;
	environment: Record<string, string>;
	command: string;
	args: string[];
}

export class TmuxLaunchError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "TmuxLaunchError";
	}
}

export function isTmuxTuiAvailable(
	env: NodeJS.ProcessEnv = process.env,
	run: CommandRunner = defaultRun,
): boolean {
	if (!env.TMUX || !env.TMUX_PANE || !/^%\d+$/.test(env.TMUX_PANE)) return false;
	try {
		run("tmux", ["display-message", "-p", "-t", env.TMUX_PANE, "#{pane_id}"]);
		return true;
	} catch {
		return false;
	}
}

export function buildTmuxLaunchArgs(
	params: TmuxPaneLaunch,
	hostScript = path.join(import.meta.dirname, "pane-host.sh"),
): string[] {
	const environment = Object.entries(params.environment).flatMap(([name, value]) => [
		"-e",
		`${name}=${value}`,
	]);
	return [
		"split-window",
		"-d",
		"-h",
		"-t",
		params.parentPane,
		"-c",
		params.cwd,
		"-P",
		"-F",
		"#{pane_id}",
		...environment,
		"sh",
		hostScript,
		params.channelDirectory,
		params.channelToken,
		params.command,
		...params.args,
	];
}

export class TmuxClient {
	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly run: CommandRunner = defaultRun,
	) {}

	available(): boolean {
		return isTmuxTuiAvailable(this.env, this.run);
	}

	launch(params: Omit<TmuxPaneLaunch, "parentPane">): string {
		const parentPane = this.env.TMUX_PANE;
		if (!parentPane || !this.available()) throw new TmuxLaunchError("tmux parent pane is unavailable.");
		let pane: string | undefined;
		try {
			pane = this.run("tmux", buildTmuxLaunchArgs({ ...params, parentPane })).trim();
			if (!/^%\d+$/.test(pane)) throw new Error("tmux did not return a pane id");
			this.run("tmux", ["select-pane", "-t", pane, "-T", params.title]);
			return pane;
		} catch (error) {
			if (pane && /^%\d+$/.test(pane)) this.kill(pane);
			throw new TmuxLaunchError("Could not launch an interactive tmux child pane.", { cause: error });
		}
	}

	alive(pane: string): boolean {
		try {
			return this.run("tmux", ["display-message", "-p", "-t", pane, "#{pane_dead}"]).trim() === "0";
		} catch {
			return false;
		}
	}

	kill(pane: string): void {
		try {
			this.run("tmux", ["kill-pane", "-t", pane]);
		} catch {
			// The user may already have closed the pane.
		}
	}
}

export function createTmuxClient(
	env: NodeJS.ProcessEnv = process.env,
	run: CommandRunner = defaultRun,
): TmuxClient {
	return new TmuxClient(env, run);
}
