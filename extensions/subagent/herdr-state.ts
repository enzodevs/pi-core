import { execFile } from "node:child_process";

/** Best-effort, coalesced presentation updates; never part of the control protocol. */
export class HerdrStateReporter {
	private pending: string[] | undefined;
	private sending = false;
	private sequence = Date.now() * 1_000;

	constructor(private readonly env: NodeJS.ProcessEnv = process.env) {}

	state(state: "working" | "blocked" | "idle", sessionFile: string | undefined, message?: string): void {
		if (!this.env.PI_CORE_SUBAGENT_HERDR || !this.env.HERDR_PANE_ID || !this.env.HERDR_SOCKET_PATH) return;
		this.pending = [
			"pane",
			"report-agent",
			this.env.HERDR_PANE_ID,
			"--source",
			"pi-core:subagent",
			"--agent",
			"pi",
			"--state",
			state,
			"--seq",
			String(++this.sequence),
			...(sessionFile ? ["--agent-session-path", sessionFile] : []),
			...(message ? ["--message", message] : []),
		];
		this.flush();
	}

	release(): void {
		if (!this.env.PI_CORE_SUBAGENT_HERDR || !this.env.HERDR_PANE_ID || !this.env.HERDR_SOCKET_PATH) return;
		this.pending = [
			"pane",
			"release-agent",
			this.env.HERDR_PANE_ID,
			"--source",
			"pi-core:subagent",
			"--agent",
			"pi",
			"--seq",
			String(++this.sequence),
		];
		this.flush();
	}

	private flush(): void {
		if (this.sending || !this.pending) return;
		const args = this.pending;
		this.pending = undefined;
		this.sending = true;
		execFile(
			this.env.HERDR_BIN_PATH || "herdr",
			args,
			{ env: this.env, timeout: 1_000, maxBuffer: 16 * 1024 },
			() => {
				this.sending = false;
				this.flush();
			},
		);
	}
}
