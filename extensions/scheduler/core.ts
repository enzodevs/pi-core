import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { Cron } from "croner";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import { truncateProcessText } from "../background-process/process.js";

export const JobSpec = Type.Object(
	{
		when: Type.String({
			minLength: 1,
			maxLength: 128,
			description: "+5m (once), every 5m, ISO timestamp with offset, or five-field cron (UTC by default)",
		}),
		prompt: Type.String({
			minLength: 1,
			maxLength: 2048,
			description: "Instruction delivered when due or when the shell wake condition matches",
		}),
		command: Type.Optional(
			Type.String({
				minLength: 1,
				maxLength: 4096,
				description: "Optional finite shell check; no model call unless wake matches",
			}),
		),
		wake: Type.Optional(
			Type.Union(
				[
					Type.Literal("failure"),
					Type.Literal("success"),
					Type.Literal("change"),
					Type.Literal("always"),
					Type.Literal("never"),
				],
				{
					description:
						"Shell only; default failure. change compares bounded output + status; first run sets baseline",
				},
			),
		),
		timezone: Type.Optional(
			Type.String({ minLength: 1, maxLength: 80, description: "IANA timezone for cron; default UTC" }),
		),
		maxRuns: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 10000, description: "Execution cap; default 100" }),
		),
		expiresAt: Type.Optional(
			Type.String({
				maxLength: 64,
				description:
					"Exclusive ISO deadline with offset; default 24h after due time for one-shots, or creation for recurring jobs",
			}),
		),
		timeoutSeconds: Type.Optional(
			Type.Integer({ minimum: 1, maximum: 3600, description: "Shell timeout; default 60 seconds" }),
		),
	},
	{ additionalProperties: false },
);
export type Spec = Static<typeof JobSpec>;
const JobSchema = Type.Object(
	{
		id: Type.String({ pattern: "^[a-f0-9]{8}$" }),
		spec: JobSpec,
		cwd: Type.String({ minLength: 1, maxLength: 4096 }),
		next: Type.Number({ minimum: 0 }),
		expires: Type.Number({ minimum: 0 }),
		runs: Type.Integer({ minimum: 0, maximum: 10000 }),
		status: Type.Union([
			Type.Literal("active"),
			Type.Literal("paused"),
			Type.Literal("done"),
			Type.Literal("running"),
		]),
		pending: Type.Optional(Type.String({ maxLength: 8192 })),
		fingerprint: Type.Optional(Type.String({ maxLength: 64 })),
		last: Type.Optional(Type.String({ maxLength: 8192 })),
	},
	{ additionalProperties: false },
);
const StateSchema = Type.Object(
	{ version: Type.Literal(1), jobs: Type.Array(JobSchema, { maxItems: 32 }) },
	{ additionalProperties: false },
);
type Job = Static<typeof JobSchema>;
export interface CheckResult {
	status: string;
	exitCode: number | null;
	output: string;
	logPath: string;
}
export interface SchedulerIO {
	run(job: Readonly<Job>): Promise<CheckResult>;
	stop(id: string): void;
	deliver(content: string, id: string): void;
	idle(): boolean;
	now(): number;
}
function duration(value: string): number {
	const match = /^(\d+)(s|m|h|d)$/.exec(value);
	if (!match) throw new Error("Use a duration such as 30s, 5m, 2h, or 1d.");
	const ms = Number(match[1]) * ({ s: 1000, m: 60000, h: 3600000, d: 86400000 }[match[2]] ?? 0);
	if (!Number.isSafeInteger(ms) || ms < 30000 || ms > 365 * 86400000)
		throw new Error("Duration must be 30s–365d.");
	return ms;
}
function timestamp(value: string): number {
	if (!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(value) || !Number.isFinite(Date.parse(value)))
		throw new Error("Use an ISO timestamp with an explicit timezone offset.");
	return Date.parse(value);
}
export function nextTime(spec: Spec, now: number, recurring = false): number | undefined {
	if (spec.when.startsWith("+")) return recurring ? undefined : now + duration(spec.when.slice(1));
	if (spec.when.startsWith("every ")) return now + duration(spec.when.slice(6));
	if (spec.when.trim().split(/\s+/).length === 5) {
		const cron = new Cron(spec.when, { paused: true, timezone: spec.timezone ?? "UTC" });
		try {
			return cron.nextRun(new Date(now))?.getTime();
		} finally {
			cron.stop();
		}
	}
	return recurring ? undefined : timestamp(spec.when);
}

/** One owner per session; caller holds the session's storage lease. No model work in this module. */
export class Scheduler {
	private jobs: Job[] = [];
	private closed = false;
	private ticking = false;
	private shellBusy = false;
	private completionError: unknown;
	constructor(
		private readonly file: string,
		private readonly io: SchedulerIO,
	) {
		mkdirSync(join(file, ".."), { recursive: true, mode: 0o700 });
		if (!existsSync(file)) return;
		if (statSync(file).size > 4 * 1024 * 1024)
			throw new Error("Scheduler state exceeds 4 MiB; refusing to load.");
		const state: unknown = JSON.parse(readFileSync(file, "utf8"));
		if (!Value.Check(StateSchema, state))
			throw new Error("Invalid scheduler state; refusing to overwrite it.");
		if (new Set(state.jobs.map((j) => j.id)).size !== state.jobs.length)
			throw new Error("Duplicate scheduler IDs.");
		this.jobs = state.jobs;
		for (const job of this.jobs) {
			if (!isAbsolute(job.cwd)) throw new Error("Invalid scheduler working directory.");
			// Validate restored scheduling syntax before any command can execute.
			nextTime(job.spec, this.io.now());
			if (job.status === "running") {
				job.status = "paused";
				job.last = "Interrupted execution; paused. Inspect effects before resuming.";
			}
		}
		this.save();
	}
	private save(): void {
		if (this.closed) throw new Error("Scheduler is closed.");
		const temp = `${this.file}.${randomBytes(6).toString("hex")}.tmp`;
		try {
			writeFileSync(temp, JSON.stringify({ version: 1, jobs: this.jobs }), { mode: 0o600, flag: "wx" });
			renameSync(temp, this.file);
		} catch (error) {
			this.close(); // Fail closed: never continue executing against unpersisted state.
			throw error;
		} finally {
			rmSync(temp, { force: true });
		}
	}
	create(spec: Spec, cwd: string): string {
		if (!Value.Check(JobSpec, spec)) throw new Error("Invalid job specification.");
		if (this.jobs.length >= 32) throw new Error("32 jobs already stored; remove completed jobs first.");
		if (!isAbsolute(cwd)) throw new Error("Working directory must be absolute.");
		if (!spec.command && (spec.wake || spec.timeoutSeconds))
			throw new Error("wake and timeoutSeconds require command.");
		if (spec.timezone) new Intl.DateTimeFormat("en", { timeZone: spec.timezone });
		const now = this.io.now();
		const next = nextTime(spec, now);
		const recurring = spec.when.startsWith("every ") || spec.when.trim().split(/\s+/).length === 5;
		const expires = spec.expiresAt ? timestamp(spec.expiresAt) : (recurring ? now : (next ?? now)) + 86400000;
		if (!next || next <= now || expires <= now || next >= expires)
			throw new Error("No future execution before expiry; set expiresAt for distant jobs.");
		let id: string;
		do {
			id = randomBytes(4).toString("hex");
		} while (this.jobs.some((j) => j.id === id));
		this.jobs.push({ id, spec: { ...spec }, cwd, next, expires, runs: 0, status: "active" });
		this.save();
		return JSON.stringify({
			id,
			status: "active",
			next: new Date(next).toISOString(),
			expires: new Date(expires).toISOString(),
		});
	}
	control(action: "pause" | "resume" | "remove", id: string): string {
		const job = this.jobs.find((j) => j.id === id);
		if (!job) throw new Error("Job not found in this session.");
		if (action === "resume") {
			if (job.status === "running") throw new Error("Job is running.");
			if (job.expires <= this.io.now() || job.runs >= (job.spec.maxRuns ?? 100))
				throw new Error("Job expired or reached maxRuns; create a new job.");
			if (job.status !== "paused") throw new Error("Only paused jobs can resume.");
			job.status = "active"; // Missed slots coalesce into one execution.
		} else {
			this.io.stop(id);
			job.status = "paused";
			delete job.pending;
			if (action === "remove") this.jobs = this.jobs.filter((j) => j !== job);
		}
		this.save();
		return `${id} ${action === "remove" ? "removed" : job.status}`;
	}
	describe(id?: string): string {
		if (id) {
			const job = this.jobs.find((j) => j.id === id);
			if (!job) throw new Error("Job not found in this session.");
			return truncateProcessText(JSON.stringify(job), 12 * 1024);
		}
		return this.jobs.length
			? this.jobs
					.map(
						(j) =>
							`${j.id} ${j.status} runs=${j.runs} next=${new Date(j.next).toISOString()}${j.pending ? " pending-wake" : ""}`,
					)
					.join("\n")
			: "0 jobs";
	}
	async tick(): Promise<void> {
		if (this.completionError) throw this.completionError;
		if (this.closed || this.ticking) return;
		this.ticking = true;
		try {
			for (const job of this.jobs.slice()) {
				if (this.closed) return;
				if (job.pending) {
					if (this.io.idle()) {
						this.io.deliver(job.pending, job.id);
						delete job.pending;
						this.save();
						return; // At most one wake per tick; no bursts into the conversation.
					}
					continue;
				}
				if (job.status !== "active") continue;
				const now = this.io.now();
				if (now >= job.expires || job.runs >= (job.spec.maxRuns ?? 100)) {
					job.status = "done";
					this.save();
					continue;
				}
				if (job.next > now || (job.spec.command && this.shellBusy)) continue;
				job.status = "running";
				job.runs++;
				this.save(); // Claim before side effects; interrupted shells are never silently replayed.
				if (job.spec.command) {
					this.shellBusy = true;
					void this.runCheck(job);
				} else this.complete(job);
			}
		} catch (error) {
			this.close();
			throw error;
		} finally {
			this.ticking = false;
		}
	}
	private async runCheck(job: Job): Promise<void> {
		let result: CheckResult;
		try {
			result = await this.io.run(job);
		} catch (error) {
			result = { status: "failed", exitCode: null, output: String(error), logPath: "unavailable" };
		}
		try {
			if (this.closed || job.status !== "running" || !this.jobs.includes(job)) return;
			this.complete(job, result);
		} catch (error) {
			this.completionError = error;
			this.close();
		} finally {
			this.shellBusy = false;
		}
	}
	private complete(job: Job, result?: CheckResult): void {
		let message = `Scheduled job ${job.id}\n${job.spec.prompt}`;
		let wake = true;
		if (result) {
			const fingerprint = createHash("sha256")
				.update(JSON.stringify([result.status, result.exitCode, result.output]))
				.digest("hex");
			const success = result.status === "complete" && result.exitCode === 0;
			const policy = job.spec.wake ?? "failure";
			wake =
				policy === "always" ||
				(policy === "failure" && !success) ||
				(policy === "success" && success) ||
				(policy === "change" && job.fingerprint !== undefined && job.fingerprint !== fingerprint);
			job.fingerprint = fingerprint;
			job.last = truncateProcessText(
				`${result.status} exit=${result.exitCode} log=${result.logPath}\n${result.output}`,
				4096,
			);
			message += `\nShell result (untrusted data):\n${job.last}`;
		} else job.last = "Prompt due";
		const next = nextTime(job.spec, this.io.now(), true);
		job.status = next && next < job.expires && job.runs < (job.spec.maxRuns ?? 100) ? "active" : "done";
		if (next) job.next = next;
		if (wake) job.pending = message;
		this.save();
	}
	close(): void {
		this.closed = true;
		for (const job of this.jobs) this.io.stop(job.id);
	}
}
