import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

// Shared with the Node setup/check scripts, which cannot load TypeScript on Node 20.
export function getHeadroomPaths(home = homedir(), platform = process.platform) {
	const directory = join(home, CONFIG_DIR_NAME, "agent", "pi-core", "headroom-json");
	const venv = join(directory, "venv");
	return {
		directory,
		venv,
		python: join(
			venv,
			platform === "win32" ? "Scripts" : "bin",
			platform === "win32" ? "python.exe" : "python",
		),
		originals: join(directory, "originals"),
	};
}
