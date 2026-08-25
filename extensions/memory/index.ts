import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { formatMemoryContext, mergeMemoryHits, parseMemoryHits } from "./context.ts";

const SEARCH_TIMEOUT_MS = 10_000;
const JOURNAL_TIMEOUT_MS = 2_000;
const MEMORY_MESSAGE_TYPE = "pi-core-memory-context";

export default function memoryContext(pi: ExtensionAPI): void {
	let openingLookupAttempted = false;

	pi.on("session_start", () => {
		openingLookupAttempted = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (openingLookupAttempted || !event.prompt.trim()) return;
		openingLookupAttempted = true;

		const common = ["search", event.prompt, "--json", "--limit", "4"];
		const globalRoot = path.join(os.homedir(), ".agents", "memory", "global");
		const [project, global] = await Promise.all([
			pi.exec("agent-memory", ["--from", ctx.cwd, ...common], { timeout: SEARCH_TIMEOUT_MS }),
			pi.exec("agent-memory", ["--root", globalRoot, ...common], { timeout: SEARCH_TIMEOUT_MS }),
		]);
		const hits = mergeMemoryHits([
			project.code === 0 ? parseMemoryHits(project.stdout) : [],
			global.code === 0 ? parseMemoryHits(global.stdout) : [],
		]);
		if (hits.length === 0) return;

		return {
			message: {
				customType: MEMORY_MESSAGE_TYPE,
				content: formatMemoryContext(hits),
				display: false,
				details: { count: hits.length },
			},
		};
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		await pi.exec(
			"agent-memory",
			["--from", ctx.cwd, "journal", "enqueue", "--session", sessionFile, "--project", ctx.cwd, "--json"],
			{ timeout: JOURNAL_TIMEOUT_MS },
		);
	});
}
