import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getPythonPaths } from "./paths.mjs";

// Explicit setup only. Loading the extension never installs or downloads anything.
const PYTHON_VERSION = "3.15";
const { directory, venv, python } = getPythonPaths();
mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const args of [
	["python", "install", PYTHON_VERSION],
	["venv", "--allow-existing", "--python", PYTHON_VERSION, venv],
	[
		"pip",
		"sync",
		"--python",
		python,
		"--require-hashes",
		fileURLToPath(new URL("./requirements.txt", import.meta.url)),
	],
]) {
	const result = spawnSync("uv", args, { stdio: "inherit" });
	if (result.error) console.error(result.error.message);
	if (result.status !== 0) process.exit(result.status ?? 1);
}
console.log(
	`Python ${PYTHON_VERSION} kernel runtime ready at ${venv}. Restart Pi or run /reload to enable the python tool.`,
);
