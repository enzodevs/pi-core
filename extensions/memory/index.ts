import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	CONSOLIDATION_MODEL,
	CONSOLIDATION_PROVIDER,
	firstPendingJob,
	launchConsolidator,
	shouldEnqueueSession,
} from "./consolidator.ts";
import { formatMemoryContext, mergeMemoryHits, parseMemoryHits } from "./context.ts";

const SEARCH_TIMEOUT_MS = 1_500;
const JOURNAL_TIMEOUT_MS = 2_000;
const MEMORY_MESSAGE_TYPE = "pi-core-memory-context";
const APPROVAL_STATUS_KEY = "pi-core-memory-approval";
function maintenanceSummary(label: string, stdout: string): string {
	try {
		const value = JSON.parse(stdout) as {
			report?: {
				jobs?: { by_status?: Record<string, number> };
				candidates?: { by_status?: Record<string, number> };
				global_approval_pending?: number;
			};
		};
		const jobs = value.report?.jobs?.by_status ?? {};
		const candidates = value.report?.candidates?.by_status ?? {};
		return `${label}: pending=${jobs.pending ?? 0}, analyzed=${jobs.analyzed ?? 0}, stale=${candidates.stale ?? 0}, approvals=${value.report?.global_approval_pending ?? 0}`;
	} catch {
		return `${label}: unavailable`;
	}
}

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
	const globalRoot = path.join(os.homedir(), ".agents", "memory", "global");

	const refreshApprovalStatus = async (ctx: ExtensionContext) => {
		const result = await pi.exec(
			"agent-memory",
			["--root", globalRoot, "candidate", "list", "--status", "pending", "--json"],
			{ timeout: JOURNAL_TIMEOUT_MS },
		);
		let count = 0;
		try {
			const value = JSON.parse(result.stdout) as { candidates?: Array<{ approval_required?: boolean }> };
			count = value.candidates?.filter((candidate) => candidate.approval_required).length ?? 0;
		} catch {}
		ctx.ui.setStatus(APPROVAL_STATUS_KEY, count > 0 ? `memory approval: ${count}` : undefined);
	};

	pi.on("session_start", async (_event, ctx) => {
		openingLookupAttempted = false;
		if (isConsolidator) return;
		await pi.exec("agent-memory", ["--from", ctx.cwd, "init", "--scope", "project"], {
			timeout: JOURNAL_TIMEOUT_MS,
		});
		await refreshApprovalStatus(ctx);
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (isConsolidator || openingLookupAttempted || !event.prompt.trim()) return;
		openingLookupAttempted = true;

		const common = ["search", event.prompt, "--json", "--limit", "2", ...EMBEDDING_ARGS];
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

	pi.registerCommand("memory-approve", {
		description: "Approve and apply one pending global memory candidate",
		handler: async (args, ctx) => {
			const candidateId = args.trim();
			if (!/^candidate-[a-f0-9]{24}$/.test(candidateId)) {
				ctx.ui.notify("Usage: /memory-approve candidate-<24 hex characters>", "error");
				return;
			}
			if (!ctx.hasUI || !(await ctx.ui.confirm("Approve global memory candidate?", candidateId))) return;
			const approved = await pi.exec(
				"agent-memory",
				["--root", globalRoot, "candidate", "approve", candidateId, "--json"],
				{ timeout: JOURNAL_TIMEOUT_MS },
			);
			if (approved.code !== 0) {
				ctx.ui.notify(approved.stderr.trim() || "Memory candidate approval failed", "error");
				return;
			}
			const applied = await pi.exec(
				"agent-memory",
				["--root", globalRoot, "candidate", "apply", candidateId, "--json"],
				{ timeout: JOURNAL_TIMEOUT_MS },
			);
			ctx.ui.notify(
				applied.code === 0 ? "Global memory candidate applied" : "Memory candidate apply failed",
				applied.code === 0 ? "info" : "error",
			);
			await refreshApprovalStatus(ctx);
		},
	});

	pi.registerCommand("memory-status", {
		description: "Show bounded project and global memory maintenance status",
		handler: async (_args, ctx) => {
			const [project, global] = await Promise.all([
				pi.exec("agent-memory", ["--from", ctx.cwd, "maintenance", "report", "--json"], {
					timeout: JOURNAL_TIMEOUT_MS,
				}),
				pi.exec("agent-memory", ["--root", globalRoot, "maintenance", "report", "--json"], {
					timeout: JOURNAL_TIMEOUT_MS,
				}),
			]);
			ctx.ui.notify(
				`${maintenanceSummary("project", project.stdout)}\n${maintenanceSummary("global", global.stdout)}`,
				"info",
			);
		},
	});

	pi.on("session_shutdown", async (event, ctx) => {
		if (isConsolidator || !shouldEnqueueSession(event.reason)) return;
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
		await pi.exec("agent-memory", ["--from", ctx.cwd, "maintenance", "reconcile", "--json"], {
			timeout: JOURNAL_TIMEOUT_MS,
		});
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
