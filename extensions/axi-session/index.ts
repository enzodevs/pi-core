import { access } from "node:fs/promises";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { axiPidFile, axiSessionName } from "./core.js";

const SESSION_ENV = "CHROME_DEVTOOLS_AXI_SESSION";

export default function axiSession(pi: ExtensionAPI): void {
	let activeSession: string | undefined;
	let previousSession: string | undefined;

	pi.on("session_start", (_event, ctx) => {
		previousSession = process.env[SESSION_ENV];
		activeSession = axiSessionName(ctx.sessionManager.getSessionId());
		process.env[SESSION_ENV] = activeSession;
	});

	pi.on("session_shutdown", async (event) => {
		const session = activeSession;
		activeSession = undefined;

		if (session && process.env[SESSION_ENV] === session) {
			if (previousSession === undefined) delete process.env[SESSION_ENV];
			else process.env[SESSION_ENV] = previousSession;
		}
		previousSession = undefined;

		if (!session || event.reason === "reload") return;
		try {
			await access(axiPidFile(session));
		} catch {
			return;
		}

		try {
			await pi.exec("env", [`${SESSION_ENV}=${session}`, "chrome-devtools-axi", "stop"], {
				timeout: 10_000,
			});
		} catch {
			// Cleanup must not prevent Pi from shutting down.
		}
	});
}
