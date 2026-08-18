import { homedir } from "node:os";
import { join } from "node:path";
import { CONFIG_DIR_NAME } from "@earendil-works/pi-coding-agent";

export function getStoragePaths(home = homedir()) {
	const directory = join(home, CONFIG_DIR_NAME, "agent", "pi-core");
	return {
		directory,
		config: join(directory, "skill-manager.json"),
		index: join(directory, "skill-index.json"),
	};
}
