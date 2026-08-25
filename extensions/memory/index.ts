import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	CONSOLIDATION_MODEL,
	CONSOLIDATION_PROVIDER,
	firstPendingJob,
	launchConsolidator,
} from "./consolidator.ts";
import { formatMemoryContext, mergeMemoryHits, parseMemoryHits } from "./context.ts";

const SEARCH_TIMEOUT_MS = 3_000;
const JOURNAL_TIMEOUT_MS = 2_000;
const MEMORY_MESSAGE_TYPE = "pi-core-memory-context";
const EMBEDDING_ARGS = [
	"--embedding-model",
	"ibm-granite/granite-embedding-311m-multilingual-r2",
	"--embedding-emitted-dimensions",
	"768",
	"--embedding-dimensions",
	"256",
	"--embedding-batch-size",
	"1",
	"--min-score",
	"0.84",
] as const;

export default function memoryContext(pi: ExtensionAPI): void {
	let openingLookupAttempted = false;
	const isConsolidator = process.env.PI_CORE_MEMORY_CONSOLIDATOR === "1";

	pi.on("session_start", () => {
		openingLookupAttempted = false;
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (isConsolidator || openingLookupAttempted || !event.prompt.trim()) return;
		openingLookupAttempted = true;

		const common = ["search", event.prompt, "--json", "--limit", "2", ...EMBEDDING_ARGS];
		const globalRoot = path.join(os.homedir(), ".agents", "memory", "global");
		// The local embedding server is intentionally single-slot. Run searches
		// sequentially so project and global cache misses cannot overload the same
		// llama-server process concurrently.
		const project = await pi.exec("agent-memory", ["--from", ctx.cwd, ...common], {
			timeout: SEARCH_TIMEOUT_MS,
		});
		const global = await pi.exec("agent-memory", ["--root", globalRoot, ...common], {
			timeout: SEARCH_TIMEOUT_MS,
		});
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
		if (isConsolidator) return;
		const sessionFile = ctx.sessionManager.getSessionFile();
		if (!sessionFile) return;
		const enqueued = await pi.exec(
			"agent-memory",
			["--from", ctx.cwd, "journal", "enqueue", "--session", sessionFile, "--project", ctx.cwd, "--json"],
			{ timeout: JOURNAL_TIMEOUT_MS },
		);
		if (enqueued.code !== 0) return;

		const model = ctx.modelRegistry.find(CONSOLIDATION_PROVIDER, CONSOLIDATION_MODEL);
		if (!model || !ctx.modelRegistry.hasConfiguredAuth(model)) return;
		const pending = await pi.exec(
			"agent-memory",
			["--from", ctx.cwd, "journal", "list", "--status", "pending", "--json"],
			{ timeout: JOURNAL_TIMEOUT_MS },
		);
		if (pending.code !== 0) return;
		const job = firstPendingJob(pending.stdout);
		if (job) launchConsolidator(job, ctx.cwd);
	});
}
