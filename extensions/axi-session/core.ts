import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

const AXI_SESSION_PREFIX = "pi-";

export function axiSessionName(sessionId: string): string {
	const digest = createHash("sha256").update(sessionId).digest("hex").slice(0, 20);
	return `${AXI_SESSION_PREFIX}${digest}`;
}

export function axiPidFile(sessionName: string, home = homedir()): string {
	return join(home, ".chrome-devtools-axi", "sessions", sessionName, "bridge.pid");
}
