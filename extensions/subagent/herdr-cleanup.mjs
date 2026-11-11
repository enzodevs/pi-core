import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// The pane host execs this only after Pi exits, keeping the owned foreground job
// alive until cleanup. Never infer ownership from an idle shell or a saved pane ID.
const [directory, token] = process.argv.slice(2);
const env = process.env;

try {
	if (
		!directory ||
		!token ||
		env.PI_CORE_SUBAGENT_HERDR !== "1" ||
		env.HERDR_ENV !== "1" ||
		!env.HERDR_SOCKET_PATH ||
		!env.HERDR_PANE_ID
	) {
		throw new Error("Missing owned Herdr caller context.");
	}
	const result = JSON.parse(readFileSync(join(directory, "result.json"), "utf8"));
	const exit = JSON.parse(readFileSync(join(directory, "exit.json"), "utf8"));
	if (
		result.version !== 1 ||
		result.token !== token ||
		result.status !== "complete" ||
		exit.version !== 1 ||
		exit.token !== token ||
		exit.code !== 0
	) {
		throw new Error("Successful handoff and clean Pi exit were not confirmed.");
	}
	const request = (args) => {
		const response = JSON.parse(
			execFileSync(env.HERDR_BIN_PATH || "herdr", args, {
				encoding: "utf8",
				timeout: 5_000,
				maxBuffer: 256 * 1024,
				stdio: ["ignore", "pipe", "pipe"],
			}),
		);
		if (response.error || !response.result) throw new Error("Herdr request was not confirmed.");
		return response.result;
	};
	// --current follows the host's caller context even after a pane move.
	const { process_info: info } = request(["pane", "process-info", "--current"]);
	if (
		typeof info?.pane_id !== "string" ||
		!info.pane_id ||
		!Array.isArray(info.foreground_processes) ||
		!info.foreground_processes.some((entry) => entry.pid === process.pid)
	) {
		throw new Error("The cleanup host no longer owns the pane's foreground job.");
	}
	// IDs are not reused. A move/close racing this request fails rather than targeting another pane.
	request(["pane", "close", info.pane_id]);
} catch {
	// Cleanup is best effort, never an excuse to retry a destructive request or lose a handoff.
	console.error("Pi child terminal retained: safe automatic close could not be confirmed.");
}
