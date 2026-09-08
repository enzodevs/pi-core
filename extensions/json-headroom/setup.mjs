import { spawnSync } from "node:child_process";
import { mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getHeadroomPaths } from "./paths.mjs";

// Explicit setup only. Loading the extension never installs or downloads anything.
const { directory, venv, python } = getHeadroomPaths();
mkdirSync(directory, { recursive: true, mode: 0o700 });
for (const args of [
	["venv", "--allow-existing", "--python", "python3", venv],
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
console.log("Headroom JSON runtime installed. Enable per Pi process with /headroom-json on.");
