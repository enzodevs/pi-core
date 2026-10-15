import { createHash } from "node:crypto";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { type ExtensionAPI, type ExtensionContext, getAgentDir } from "@earendil-works/pi-coding-agent";
import { lock } from "proper-lockfile";
import { Type } from "typebox";
import { ProcessLogStore } from "../background-process/log-store.js";
import { type ProcessHandle, runBackgroundProcess } from "../background-process/process.js";
import { JobSpec, Scheduler } from "./core.js";

const Parameters = Type.Object(
	{
		action: Type.Union([
			Type.Literal("create"),
			Type.Literal("list"),
			Type.Literal("pause"),
			Type.Literal("resume"),
			Type.Literal("remove"),
		]),
		job: Type.Optional(JobSpec),
		id: Type.Optional(
			Type.String({
				pattern: "^[a-f0-9]{8}$",
				description: "Job ID; list with id returns details and last result",
			}),
		),
	},
	{ additionalProperties: false },
);

export default function schedulerExtension(pi: ExtensionAPI): void {
	let scheduler: Scheduler | undefined;
	let context: ExtensionContext | undefined;
	let timer: ReturnType<typeof setInterval> | undefined;
	let release: (() => Promise<void>) | undefined;
	let generation = 0;
	let lifecycle = Promise.resolve();
	let failure = "Scheduler not started.";
	const handles = new Map<string, ProcessHandle>();
	const halt = () => {
		if (timer) clearInterval(timer);
		timer = undefined;
		scheduler?.close();
		scheduler = undefined;
		for (const handle of handles.values()) handle.stop();
		handles.clear();
	};
	const report = (error: unknown) => {
		failure = String(error).slice(0, 512);
		halt();
		context?.ui.notify(`Scheduler stopped: ${failure}`, "error");
	};
	const tick = async () => {
		try {
			await scheduler?.tick();
		} catch (error) {
			report(error);
		}
	};
	const start = (ctx: ExtensionContext) => {
		const ownGeneration = ++generation;
		halt();
		context = ctx;
		lifecycle = lifecycle
			.then(async () => {
				await release?.();
				release = undefined;
				if (generation !== ownGeneration) return;
				const key = createHash("sha256").update(ctx.sessionManager.getSessionId()).digest("hex");
				const root = join(getAgentDir(), "pi-core", "scheduler", key);
				mkdirSync(root, { recursive: true, mode: 0o700 });
				release = await lock(root, { realpath: false, retries: 0, onCompromised: report });
				if (generation !== ownGeneration) return;
				const logs = new ProcessLogStore({ root: join(root, "logs"), segmentBytes: 256 * 1024 });
				scheduler = new Scheduler(join(root, "jobs.json"), {
					now: Date.now,
					idle: () => context?.isIdle() === true,
					stop: (id) => handles.get(id)?.stop(),
					deliver: (content, id) =>
						pi.sendMessage(
							{ customType: "pi-core-schedule", content, display: true, details: { id } },
							{ deliverAs: "followUp", triggerTurn: true },
						),
					run: async (job) => {
						const command = job.spec.command;
						if (!command) throw new Error("Shell job requires command.");
						const log = logs.create(job.id);
						try {
							const result = await runBackgroundProcess({
								command,
								cwd: job.cwd,
								mode: "wait",
								timeoutSeconds: job.spec.timeoutSeconds ?? 60,
								log,
								onSpawn: (handle) => handles.set(job.id, handle),
							});
							return { ...result, logPath: join(root, "logs", `${job.id}.log`) };
						} finally {
							if (generation === ownGeneration) handles.delete(job.id);
						}
					},
				});
				failure = "";
				timer = setInterval(() => void tick(), 1000);
				timer.unref();
				void tick();
			})
			.catch(report);
		return lifecycle;
	};
	pi.on("session_start", (_event, ctx) => start(ctx));
	// Branch changes do not rewind external schedules or replay shell side effects.
	pi.on("session_tree", (_event, ctx) => {
		context = ctx;
	});
	pi.on("agent_settled", () => {
		void tick();
	});
	pi.on("session_shutdown", async () => {
		generation++;
		halt();
		await lifecycle;
		await release?.();
		release = undefined;
		context = undefined;
	});
	pi.registerTool({
		name: "schedule",
		label: "Schedule",
		exposure: "deferred",
		description:
			"Schedule persistent session-owned one-shot, interval or cron reminders, prompts and finite shell checks. Runs only while this session is open; missed slots coalesce. Shell checks wake only on failure by default. Wakes wait for idle. Interrupted runs pause. No daemon, no closed-Pi execution. Default 100 runs; recurring lifetime 24h, one-shots expire 24h after due time.",
		parameters: Parameters,
		async execute(_callId, params, _signal, _update, ctx) {
			await lifecycle;
			if (!scheduler) throw new Error(failure || "Scheduler unavailable.");
			let text: string;
			if (params.action === "create") {
				if (!params.job || params.id) throw new Error("create requires job and no id.");
				text = scheduler.create(params.job, ctx.cwd);
			} else {
				if (params.job) throw new Error("job is only accepted for create.");
				if (params.action === "list") text = scheduler.describe(params.id);
				else {
					if (!params.id) throw new Error("id is required.");
					text = scheduler.control(params.action, params.id);
				}
			}
			return { content: [{ type: "text", text }], details: undefined };
		},
	});
	pi.registerCommand("schedule", {
		description: "Inspect session schedules; /schedule [id] or /schedule pause|resume|remove <id>",
		handler: async (args, ctx) => {
			await lifecycle;
			try {
				if (!scheduler) throw new Error(failure);
				const [action, id, extra] = args.trim().split(/\s+/);
				if (extra) throw new Error("Use /schedule [id] or /schedule pause|resume|remove <id>.");
				const text =
					action === "pause" || action === "resume" || action === "remove"
						? scheduler.control(action, id ?? "")
						: scheduler.describe(action || undefined);
				ctx.ui.notify(text, "info");
			} catch (error) {
				ctx.ui.notify(String(error), "error");
			}
		},
	});
}
