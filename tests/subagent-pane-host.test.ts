import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const roots: string[] = [];
const host = path.resolve("extensions/subagent/pane-host.sh");

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function runHost(
	options: {
		status?: string;
		code?: number;
		herdr?: boolean;
		context?: boolean;
		mode?: string;
		token?: string;
	} = {},
) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-pane-host-"));
	roots.push(root);
	const command = path.join(root, "child.mjs");
	const binary = path.join(root, "herdr-fixture");
	const trace = path.join(root, "calls.jsonl");
	fs.writeFileSync(path.join(root, "session.jsonl"), "persistent session\n");
	fs.writeFileSync(path.join(root, "worktree.txt"), "preserved work\n");
	fs.writeFileSync(
		command,
		`
		import { writeFileSync } from "node:fs";
		import { join } from "node:path";
		const [directory, status, code, token] = process.argv.slice(2);
		if (status !== "missing") writeFileSync(join(directory, "result.json"), JSON.stringify({ version: 1, token, status, output: "saved handoff" }));
		process.exit(Number(code));
	`,
	);
	fs.writeFileSync(
		binary,
		`#!${process.execPath}
		import { appendFileSync, readFileSync } from "node:fs";
		import { join } from "node:path";
		const args = process.argv.slice(2);
		const root = process.env.FIXTURE_ROOT;
		const mode = process.env.FIXTURE_MODE;
		// The receipt must exist before even inspecting the pane, not just before closing it.
		const exit = JSON.parse(readFileSync(join(root, "exit.json"), "utf8"));
		appendFileSync(join(root, "calls.jsonl"), JSON.stringify({ args, exit, socket: process.env.HERDR_SOCKET_PATH }) + "\\n");
		if (mode === "offline" || (mode === "close-error" && args[1] === "close")) process.exit(1);
		if (mode === "malformed") { console.log("invalid json"); process.exit(0); }
		console.log(JSON.stringify({ result: args[1] === "process-info" ? {
			process_info: { pane_id: mode === "missing-id" ? null : "w9:p7", foreground_processes:
				mode === "unknown" ? undefined : [{ pid: mode === "reused" ? 1 : process.ppid }] }
		} : {} }));
	`,
		{ mode: 0o700 },
	);
	const result = spawnSync(
		"sh",
		[
			host,
			root,
			"owned-token",
			process.execPath,
			command,
			root,
			options.status ?? "complete",
			String(options.code ?? 0),
			options.token ?? "owned-token",
		],
		{
			encoding: "utf8",
			timeout: 15_000,
			env: {
				...process.env,
				PI_CORE_SUBAGENT_HERDR: options.herdr === false ? "" : "1",
				PI_CORE_SUBAGENT_NODE: process.execPath,
				HERDR_ENV: options.context === false ? "" : "1",
				HERDR_SOCKET_PATH: "/owned/server.sock",
				HERDR_PANE_ID: "w2:p1",
				HERDR_BIN_PATH: binary,
				FIXTURE_ROOT: root,
				FIXTURE_MODE: options.mode ?? "normal",
			},
		},
	);
	if (result.error) throw result.error;
	const calls: Array<{ args: string[]; exit: { code: number; token: string }; socket: string }> =
		fs.existsSync(trace)
			? fs
					.readFileSync(trace, "utf8")
					.trim()
					.split("\n")
					.map((line) => JSON.parse(line))
			: [];
	return { root, result, calls };
}

describe("pane host successful Herdr cleanup", () => {
	it("waits for a saved success and clean exit, follows the caller after a move, and closes only its pane", () => {
		const { root, result, calls } = runHost();
		expect(result.status, result.stderr).toBe(0);
		expect(result.stderr).toBe("");
		expect(calls.map((call) => call.args)).toEqual([
			["pane", "process-info", "--current"],
			["pane", "close", "w9:p7"],
		]);
		for (const call of calls) {
			expect(call.exit).toMatchObject({ code: 0, token: "owned-token" });
			expect(call.socket).toBe("/owned/server.sock");
		}
		expect(fs.readFileSync(path.join(root, "session.jsonl"), "utf8")).toBe("persistent session\n");
		expect(fs.readFileSync(path.join(root, "worktree.txt"), "utf8")).toBe("preserved work\n");
		expect(JSON.parse(fs.readFileSync(path.join(root, "result.json"), "utf8")).output).toBe("saved handoff");
		expect(fs.statSync(path.join(root, "exit.json")).mode & 0o777).toBe(0o600);
	});

	it.each(["failed", "stopped", "missing"])("retains %s children even with exit code zero", (status) => {
		const { result, calls } = runHost({ status });
		expect(result.status).toBe(0);
		expect(calls).toEqual([]);
		expect(result.stderr).toContain("terminal retained");
	});

	it("retains nonzero exits and preserves the actual process exit code", () => {
		const { root, result, calls } = runHost({ code: 7 });
		expect(result.status).toBe(7);
		expect(calls).toEqual([]);
		expect(JSON.parse(fs.readFileSync(path.join(root, "exit.json"), "utf8")).code).toBe(7);
	});

	it.each(["reused", "unknown", "offline", "malformed", "missing-id"])(
		"does not close when ownership is %s",
		(mode) => {
			const { result, calls } = runHost({ mode });
			expect(result.status).toBe(0);
			expect(calls).toHaveLength(1);
			expect(calls.some((call) => call.args[1] === "close")).toBe(false);
			expect(result.stderr).toContain("terminal retained");
		},
	);

	it("does not retry an unconfirmed close or convert housekeeping failure into a failed task", () => {
		const { result, calls } = runHost({ mode: "close-error" });
		expect(result.status).toBe(0);
		expect(calls.filter((call) => call.args[1] === "close")).toHaveLength(1);
		expect(result.stderr).toContain("terminal retained");
	});

	it("does not close for a foreign receipt, missing caller context, or a tmux host", () => {
		for (const options of [{ token: "foreign-token" }, { context: false }, { herdr: false }]) {
			const { result, calls } = runHost(options);
			expect(result.status).toBe(0);
			expect(calls).toEqual([]);
		}
	});
});
