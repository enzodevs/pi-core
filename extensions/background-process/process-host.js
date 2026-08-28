import { spawn } from "node:child_process";

const command = process.env.PI_CORE_BACKGROUND_PROCESS_COMMAND;
if (!command) {
	process.stderr.write("Missing PI_CORE_BACKGROUND_PROCESS_COMMAND.\n");
	process.exit(2);
}

const environment = { ...process.env };
delete environment.PI_CORE_BACKGROUND_PROCESS_COMMAND;

const child = spawn(command, [], {
	env: environment,
	shell: true,
	stdio: "inherit",
	windowsHide: true,
});

let stopping = false;
let stopHold;
if (process.platform !== "win32") {
	process.on("SIGTERM", () => {
		stopping = true;
		stopHold ??= setInterval(() => {}, 60_000);
	});
}

child.on("error", (error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
});

child.on("close", (code) => {
	if (stopping) return;
	if (stopHold) clearInterval(stopHold);
	process.exit(code ?? 1);
});
