import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { promisify } from "node:util";
import type { TmuxPaneLaunch } from "./tmux.ts";

export interface HerdrLocation {
	paneId: string;
	workspaceId: string;
	tabId: string;
	socketPath: string;
}

type RunCommand = (command: string, args: string[], env: NodeJS.ProcessEnv) => string | Promise<string>;
const execute = promisify(execFile);
const defaultRun: RunCommand = async (command, args, env) =>
	(await execute(command, args, { env, encoding: "utf8", timeout: 5_000, maxBuffer: 256 * 1024 })).stdout;

export class HerdrLaunchError extends Error {}

interface LayoutResult {
	workspace?: { workspace_id: string };
	tab?: { tab_id: string; workspace_id?: string };
	root_pane?: { pane_id: string };
	pane?: { pane_id: string };
}

function apiErrorCode(error: unknown): string | undefined {
	try {
		return JSON.parse(String((error as { stderr?: unknown }).stderr)).error?.code;
	} catch {
		return undefined;
	}
}

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

/** Layout is presentation only. All agent traffic goes through the private sidecar. */
export class HerdrClient {
	private readonly workspaces = new Map<string, string>();
	// Concurrent child starts share the first workspace creation, without serializing agent execution.
	private readonly creating = new Map<string, Promise<LayoutResult>>();

	constructor(
		private readonly env: NodeJS.ProcessEnv = process.env,
		private readonly run: RunCommand = defaultRun,
	) {}

	available(): boolean {
		return this.env.HERDR_ENV === "1" && !!this.env.HERDR_SOCKET_PATH && !!this.env.HERDR_PANE_ID;
	}

	private async request(args: string[], socketPath = this.env.HERDR_SOCKET_PATH): Promise<LayoutResult> {
		const output = await this.run(this.env.HERDR_BIN_PATH || "herdr", args, {
			...this.env,
			HERDR_SOCKET_PATH: socketPath,
		});
		// Herdr's admission-only pane run command deliberately prints nothing on success.
		if (!output.trim() && args[0] === "pane" && args[1] === "run") return {};
		const response = JSON.parse(output);
		if (response.error || !response.result)
			throw Object.assign(new Error("Herdr request failed."), { stderr: output });
		return response.result;
	}

	private async layout(parentSession: string, cwd: string, title: string): Promise<LayoutResult> {
		let workspaceId = this.env.PI_CORE_SUBAGENT_HERDR_WORKSPACE || this.workspaces.get(parentSession);
		if (workspaceId) {
			try {
				await this.request(["workspace", "get", workspaceId]);
			} catch (error) {
				if (apiErrorCode(error) !== "workspace_not_found") throw error;
				this.workspaces.delete(parentSession);
				workspaceId = undefined;
			}
		}
		if (!workspaceId) {
			const pending = this.creating.get(parentSession);
			if (pending) {
				workspaceId = (await pending).workspace?.workspace_id;
			} else {
				const creation = this.request([
					"workspace",
					"create",
					"--cwd",
					cwd,
					"--label",
					"Pi subagents",
					"--no-focus",
				]);
				this.creating.set(parentSession, creation);
				try {
					const result = await creation;
					if (typeof result.workspace?.workspace_id !== "string")
						throw new Error("Herdr returned an invalid workspace.");
					this.workspaces.set(parentSession, result.workspace.workspace_id);
					return result;
				} finally {
					this.creating.delete(parentSession);
				}
			}
		}
		if (!workspaceId) throw new Error("Herdr workspace creation was not confirmed.");
		return this.request([
			"tab",
			"create",
			"--workspace",
			workspaceId,
			"--cwd",
			cwd,
			"--label",
			title,
			"--no-focus",
		]);
	}

	remember(parentSession: string, location: HerdrLocation): void {
		if (location.socketPath === this.env.HERDR_SOCKET_PATH)
			this.workspaces.set(parentSession, location.workspaceId);
	}

	async launch(params: Omit<TmuxPaneLaunch, "parentPane">, parentSession: string): Promise<HerdrLocation> {
		if (!this.available()) throw new HerdrLaunchError("Herdr caller context is unavailable.");
		const script = path.join(params.channelDirectory, "launch.sh");
		const environment = {
			...params.environment,
			PI_CORE_SUBAGENT_HERDR: "1",
			PI_CORE_SUBAGENT_NODE: process.execPath,
		};
		fs.writeFileSync(
			script,
			`#!/bin/sh\nexec env ${Object.entries(environment)
				.map(([key, value]) => quote(`${key}=${value}`))
				.join(
					" ",
				)} ${["sh", path.join(import.meta.dirname, "pane-host.sh"), params.channelDirectory, params.channelToken, params.command, ...params.args].map(quote).join(" ")}\n`,
			{ mode: 0o600 },
		);
		let result: LayoutResult;
		try {
			result = await this.layout(parentSession, params.cwd, params.title);
		} catch (cause) {
			throw new HerdrLaunchError(
				"Herdr child layout creation failed or is unconfirmed; inspect the Pi subagents workspace before retrying.",
				{ cause },
			);
		}
		const paneId = result.root_pane?.pane_id;
		const tabId = result.tab?.tab_id;
		// Public IDs are opaque; obtain the owning workspace from Herdr's returned tab.
		const workspaceId = result.workspace?.workspace_id ?? result.tab?.workspace_id;
		if (typeof workspaceId !== "string" || typeof paneId !== "string" || typeof tabId !== "string") {
			throw new HerdrLaunchError("Herdr returned an invalid layout response.");
		}
		const location = { workspaceId, paneId, tabId, socketPath: this.env.HERDR_SOCKET_PATH as string };
		this.remember(parentSession, location);
		// Large tasks, credentials, and arguments never enter terminal input or shell history.
		const launch = `PI_CORE_SUBAGENT_HERDR_WORKSPACE=${quote(workspaceId)} sh ${quote(script)}`;
		try {
			await this.request(["pane", "run", paneId, launch]);
		} catch {
			// Admission can succeed even if its response is lost. Return the known location,
			// retain ownership, and let the sidecar startup deadline supervise it. Never relaunch.
		}
		return location;
	}

	async alive(location: HerdrLocation): Promise<boolean | undefined> {
		try {
			const result = await this.request(["pane", "get", location.paneId], location.socketPath);
			return result.pane?.pane_id === location.paneId;
		} catch (error) {
			return apiErrorCode(error) === "pane_not_found" ? false : undefined;
		}
	}
}
