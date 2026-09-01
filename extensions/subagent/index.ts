import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { type AgentConfig, discoverAgents } from "./agents.ts";
import { AskParentTurnGate, currentAssistantMessage } from "./ask-parent-gate.ts";
import { assertBoundedText, resolveSubagentLimits, truncateUtf8 as truncateToLimit } from "./limits.ts";
import {
	ASK_PARENT_PROTOCOL,
	CHILD_START_PROTOCOL,
	type ChildLineage,
	COMPLETION_MESSAGE_TYPE,
	COMPLETION_PROTOCOL,
	createChildLineage,
	decideDelegation,
	decodeChildLineage,
	ownsDirectChild,
	type PendingQuestion,
} from "./protocol.ts";
import { type ConcurrencyLease, GlobalConcurrencyLimitError, GlobalConcurrencyRegistry } from "./registry.ts";
import {
	attachAgent,
	type ChildHandle,
	type ChildRuntime,
	type RunAgentOptions,
	RunnerDetachedError,
	runAgent,
} from "./runner.ts";
import { createTmuxChildBridge } from "./tui-bridge.ts";
import {
	prepareWorkspace,
	type WorkspaceMode,
	type WorkspaceSetup,
	type WorktreeWorkspace,
} from "./worktrunk.ts";

const MAX_RECENT_RUNS = 20;
const ENTRY_TYPE = "pi-core-agent-run";
const STATUS_ID = "pi-core-background-agents";
const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

const rawLineage = process.env.PI_CORE_SUBAGENT_CONTEXT;
const childLineage = decodeChildLineage(rawLineage);
const invalidLineage = rawLineage !== undefined && childLineage === null;
const limits = childLineage?.limits ?? resolveSubagentLimits();
const registryPath =
	childLineage?.registryPath ?? path.join(getAgentDir(), "pi-core", "subagents", "concurrency.json");

const BackgroundAgentParams = Type.Object({
	agent: Type.String({ maxLength: 64, description: "Named agent profile" }),
	task: Type.String({ maxLength: limits.taskBytes, description: "Independent task" }),
	cwd: Type.Optional(Type.String({ maxLength: 4096, description: "Child CWD; default: parent CWD" })),
	workspace: Type.Optional(
		Type.Unsafe<WorkspaceMode>({
			type: "string",
			enum: ["inherit", "worktree"],
			description: "Workspace isolation; defaults to the agent profile policy",
		}),
	),
	model: Type.Optional(Type.String({ maxLength: 256, description: "Optional provider/model override" })),
	thinking: Type.Optional(
		Type.Unsafe<(typeof THINKING_LEVELS)[number]>({ type: "string", enum: THINKING_LEVELS }),
	),
});

const AgentControlParams = Type.Object({
	action: Type.Union([
		Type.Literal("status"),
		Type.Literal("message"),
		Type.Literal("reply"),
		Type.Literal("stop"),
	]),
	id: Type.Optional(Type.String({ maxLength: 32, description: "Direct child run ID" })),
	message: Type.Optional(Type.String({ maxLength: limits.replyBytes, description: "Message or reply" })),
});

const AskParentParams = Type.Object({
	question: Type.String({ maxLength: limits.questionBytes, description: "One concise blocking question" }),
});

type RunStatus = "running" | "complete" | "failed" | "stopped";
type DeliveryStatus = "none" | "pending" | "delivered";

export interface ManagedRun {
	id: string;
	agent: string;
	task: string;
	cwd: string;
	workspace?: WorkspaceMode;
	worktreeBranch?: string;
	worktreeCreated?: boolean;
	workspaceSetup?: WorkspaceSetup;
	status: RunStatus;
	activity: "starting" | "running" | "waiting";
	delivery: DeliveryStatus;
	startedAt: number;
	finishedAt?: number;
	output?: string;
	error?: string;
	question?: PendingQuestion;
	parentRunId: string | null;
	rootRunId: string;
	depth: number;
	ancestry: string[];
	runtime?: ChildRuntime;
	child?: ChildHandle;
	cancelRequested?: boolean;
	deliveryQueued?: boolean;
	generation: number;
}

export interface PersistedRun
	extends Partial<Omit<ManagedRun, "child" | "cancelRequested" | "deliveryQueued" | "generation">> {
	id: string;
}

export function truncateUtf8(text: string, maxBytes = limits.handoffBytes): string {
	return truncateToLimit(text, maxBytes);
}

function newRunId(): string {
	return randomBytes(6).toString("hex");
}

export function resolveRequestedModel(
	requested: string | undefined,
	available: ReadonlyArray<{ provider: string; id: string }>,
): string | undefined {
	if (requested === undefined) return undefined;
	const value = requested.trim();
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) throw new Error("Invalid model; expected provider/model.");
	const provider = value.slice(0, slash);
	const id = value.slice(slash + 1);
	const match = available.find((model) => model.provider === provider && model.id === id);
	if (!match) throw new Error(`Unknown or unavailable model: ${value}. Choose a provider/model from /model.`);
	return `${match.provider}/${match.id}`;
}

export function ownsRun(runs: ReadonlyMap<string, ManagedRun>, run: ManagedRun, generation: number): boolean {
	return runs.get(run.id) === run && run.generation === generation;
}

export function snapshotRun(run: ManagedRun, transition = false): PersistedRun {
	if (transition && run.delivery === "delivered") {
		return {
			id: run.id,
			status: run.status,
			delivery: run.delivery,
			finishedAt: run.finishedAt,
		};
	}
	return {
		id: run.id,
		agent: run.agent,
		task: truncateUtf8(run.task, limits.taskBytes),
		cwd: run.cwd,
		workspace: run.workspace,
		worktreeBranch: run.worktreeBranch,
		worktreeCreated: run.worktreeCreated,
		workspaceSetup: run.workspaceSetup,
		status: run.status,
		activity: run.activity,
		delivery: run.delivery,
		startedAt: run.startedAt,
		finishedAt: run.finishedAt,
		output: run.output ? truncateUtf8(run.output) : undefined,
		error: run.error ? truncateUtf8(run.error) : undefined,
		question: run.question
			? {
					...run.question,
					text: truncateUtf8(run.question.text, limits.questionBytes),
				}
			: undefined,
		parentRunId: run.parentRunId,
		rootRunId: run.rootRunId,
		depth: run.depth,
		ancestry: [...run.ancestry],
		runtime: run.runtime,
	};
}

function workspaceSetupText(workspace: WorktreeWorkspace): string {
	if (workspace.setup === "pre_start_completed") return "project pre-start hook completed";
	if (workspace.setup === "no_pre_start_hook")
		return "no project pre-start hook configured; verify dependencies before running checks";
	if (workspace.setup === "existing_worktree")
		return "existing worktree reused; verify dependencies before running checks";
	return "inherited workspace";
}

function completionText(run: ManagedRun): string {
	const body = run.status === "complete" ? run.output : run.error;
	return truncateUtf8(`agent: ${run.agent}\nid: ${run.id}\nstatus: ${run.status}\n\n${body || "No output."}`);
}

function compactStatus(run: ManagedRun): string {
	const seconds = Math.max(0, Math.round(((run.finishedAt ?? Date.now()) - run.startedAt) / 1_000));
	const state = run.status === "running" ? run.activity : run.status;
	const backend = run.runtime?.backend === "tmux-tui" ? " pane" : "";
	return `${run.id} ${run.agent} ${state}${backend} d${run.depth} ${seconds}s`;
}

function childSettlement(ctx: ExtensionContext): { status: "complete" | "failed"; output: string } {
	const message = currentAssistantMessage(ctx);
	if (!message) return { status: "failed", output: "No final assistant output returned." };
	const text = message.content
		.flatMap((part) => (part.type === "text" ? [part.text] : []))
		.join("\n\n")
		.trim();
	if (message.stopReason === "error" || message.stopReason === "aborted") {
		return {
			status: "failed",
			output: message.errorMessage || text || `Child model ${message.stopReason}.`,
		};
	}
	return { status: "complete", output: text || "No final assistant output returned." };
}

export function normalizePersistedRun(value: PersistedRun): PersistedRun | null {
	if (
		typeof value.id !== "string" ||
		typeof value.agent !== "string" ||
		typeof value.task !== "string" ||
		typeof value.cwd !== "string" ||
		!(["running", "complete", "failed", "stopped"] as const).includes(value.status as RunStatus) ||
		!(["none", "pending", "delivered"] as const).includes(value.delivery as DeliveryStatus) ||
		typeof value.startedAt !== "number"
	) {
		return null;
	}
	const legacyTopLevel =
		value.parentRunId === undefined &&
		value.rootRunId === undefined &&
		value.depth === undefined &&
		value.ancestry === undefined;
	if (legacyTopLevel) {
		return {
			...value,
			activity: value.status === "running" ? "running" : "waiting",
			parentRunId: null,
			rootRunId: value.id,
			depth: 1,
			ancestry: [value.id],
		};
	}
	if (
		!(["starting", "running", "waiting"] as const).includes(value.activity as ManagedRun["activity"]) ||
		(value.parentRunId !== null && typeof value.parentRunId !== "string") ||
		typeof value.rootRunId !== "string" ||
		!Number.isInteger(value.depth) ||
		!Array.isArray(value.ancestry) ||
		!value.ancestry.every((id) => typeof id === "string")
	) {
		return null;
	}
	if (value.runtime !== undefined) {
		const runtime = value.runtime as ChildRuntime;
		if (
			!runtime ||
			(runtime.backend !== "rpc" && runtime.backend !== "tmux-tui") ||
			typeof runtime.sessionFile !== "string" ||
			!path.isAbsolute(runtime.sessionFile) ||
			(runtime.backend === "tmux-tui" &&
				(typeof runtime.paneId !== "string" ||
					!/^%\d+$/.test(runtime.paneId) ||
					typeof runtime.channelDirectory !== "string" ||
					!path.isAbsolute(runtime.channelDirectory) ||
					typeof runtime.channelToken !== "string"))
		) {
			return null;
		}
	}
	return value;
}

export default function backgroundAgents(pi: ExtensionAPI): void {
	if (invalidLineage) return;

	const tuiBridge = childLineage ? createTmuxChildBridge(pi, childLineage, limits) : undefined;
	const runs = new Map<string, ManagedRun>();
	const concurrency = new GlobalConcurrencyRegistry({
		filePath: registryPath,
		limit: limits.globalConcurrency,
	});
	let currentCtx: ExtensionContext | undefined;
	let branchGeneration = 0;
	let questionOpen = false;

	const updateStatus = () => {
		if (!currentCtx) return;
		const active = [...runs.values()].filter((run) => run.status === "running");
		const waiting = active.filter((run) => run.activity === "waiting").length;
		const text =
			active.length > 0 ? `agents ${active.length}${waiting ? ` · ${waiting} waiting` : ""}` : undefined;
		try {
			currentCtx.ui.setStatus(STATUS_ID, text);
		} catch {
			// Session replacement invalidates the old UI context.
		}
	};
	const persist = (run: ManagedRun, transition = false) => {
		try {
			pi.appendEntry(ENTRY_TYPE, snapshotRun(run, transition));
			return true;
		} catch {
			currentCtx?.ui.notify(`Could not persist agent ${run.id} state.`, "warning");
			return false;
		}
	};
	const prune = () => {
		const completed = [...runs.values()]
			.filter((run) => run.status !== "running")
			.sort((a, b) => b.startedAt - a.startedAt);
		for (const run of completed.slice(MAX_RECENT_RUNS)) runs.delete(run.id);
	};
	const completionPresent = (run: ManagedRun) =>
		currentCtx?.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== COMPLETION_MESSAGE_TYPE) return false;
			const details = entry.details as { id?: unknown } | undefined;
			return details?.id === run.id;
		}) ?? false;
	const acknowledgeDelivery = (run: ManagedRun) => {
		if (!completionPresent(run)) return false;
		run.delivery = "delivered";
		run.deliveryQueued = false;
		persist(run, true);
		return true;
	};
	const deliverCompletion = (run: ManagedRun) => {
		if (run.delivery === "delivered" || run.status === "running" || run.deliveryQueued) return;
		if (acknowledgeDelivery(run)) return;
		try {
			pi.sendMessage(
				{
					customType: COMPLETION_MESSAGE_TYPE,
					content: completionText(run),
					display: true,
					details: {
						protocol: COMPLETION_PROTOCOL,
						id: run.id,
						agent: run.agent,
						workspace: {
							mode: run.workspace ?? "inherit",
							cwd: run.cwd,
							branch: run.worktreeBranch,
							created: run.worktreeCreated ?? false,
							setup: run.workspaceSetup ?? "not_applicable",
						},
					},
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
			run.deliveryQueued = true;
		} catch {
			run.delivery = "pending";
			run.deliveryQueued = false;
			currentCtx?.ui.notify(`Agent ${run.id} finished; delivery will retry.`, "warning");
		}
	};
	const deliverQuestion = (run: ManagedRun) => {
		const question = run.question;
		if (!question || question.delivered || run.status !== "running") return;
		try {
			pi.sendMessage(
				{
					customType: "pi-core-agent-question",
					content: truncateUtf8(
						`agent: ${run.agent}\nid: ${run.id}\nquestion: ${question.text}\n\nReply with agent_control action=reply, id=${run.id}.`,
					),
					display: true,
					details: { id: run.id, agent: run.agent, questionId: question.id },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
			question.delivered = true;
			persist(run);
		} catch {
			currentCtx?.ui.notify(`Agent ${run.id} is waiting for a reply; notification will retry.`, "warning");
		}
	};
	const finish = (run: ManagedRun, status: RunStatus, body: string) => {
		run.status = status;
		run.finishedAt = Date.now();
		run.child = undefined;
		run.question = undefined;
		run.delivery = "pending";
		run.deliveryQueued = false;
		if (status === "complete") run.output = truncateUtf8(body);
		else run.error = truncateUtf8(body);
		persist(run);
		updateStatus();
		deliverCompletion(run);
		prune();
	};
	const lineageForRun = (run: ManagedRun): ChildLineage => ({
		version: 1,
		runId: run.id,
		rootRunId: run.rootRunId,
		parentRunId: run.parentRunId,
		agent: run.agent,
		depth: run.depth,
		ancestry: [...run.ancestry],
		allowedChildren: [],
		limits: { ...limits },
		registryPath,
	});
	const supervise = (
		run: ManagedRun,
		agent: AgentConfig,
		ctx: ExtensionContext,
		lineage: ChildLineage,
		lease: ConcurrencyLease,
		start: (options: RunAgentOptions) => Promise<string>,
		dispatch: { model?: string; thinking?: string } = {},
	) => {
		const generation = run.generation;
		let preserveLease = false;
		const options: RunAgentOptions = {
			agent,
			task: run.task,
			cwd: run.cwd,
			ctx,
			lineage,
			limits,
			...dispatch,
			onSpawn(child) {
				if (!ownsRun(runs, run, generation) || run.cancelRequested) {
					child.abort();
					return;
				}
				run.child = child;
				run.runtime = child.runtime;
				run.activity = "running";
				persist(run);
				updateStatus();
			},
			onQuestion(question) {
				if (!ownsRun(runs, run, generation)) return;
				const delivered = run.question?.id === question.id && run.question.delivered;
				run.question = { ...question, delivered: Boolean(delivered) };
				run.activity = "waiting";
				persist(run);
				updateStatus();
				deliverQuestion(run);
			},
			onStatus(status) {
				if (!ownsRun(runs, run, generation)) return;
				run.activity = status.startsWith("waiting") ? "waiting" : "running";
				updateStatus();
			},
		};
		void (async () => {
			try {
				const output = await start(options);
				if (ownsRun(runs, run, generation)) finish(run, "complete", output);
			} catch (error) {
				if (error instanceof RunnerDetachedError) {
					preserveLease = true;
					return;
				}
				if (!ownsRun(runs, run, generation)) return;
				const message = error instanceof Error ? error.message : String(error);
				finish(run, message === "stopped" ? "stopped" : "failed", message);
			} finally {
				if (!preserveLease) {
					try {
						await lease.release();
					} catch {
						currentCtx?.ui.notify(`Could not release agent ${run.id} concurrency lease.`, "warning");
					}
				}
			}
		})();
	};
	const restoreActiveBranch = async (
		ctx: ExtensionContext,
		interruptedReason: string,
		treatTmuxAsAttachable: boolean,
	) => {
		branchGeneration++;
		for (const run of runs.values()) {
			run.cancelRequested = true;
			run.child?.abort();
		}
		runs.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const patch = entry.data as PersistedRun;
			if (!patch?.id) continue;
			const prior = runs.get(patch.id);
			if (prior) {
				const merged = normalizePersistedRun({ ...prior, ...patch });
				if (merged && ownsDirectChild(childLineage, merged as ManagedRun)) Object.assign(prior, merged);
				continue;
			}
			const normalized = normalizePersistedRun(patch);
			if (!normalized || !ownsDirectChild(childLineage, normalized as ManagedRun)) continue;
			runs.set(patch.id, { ...normalized, generation: branchGeneration } as ManagedRun);
		}
		const agents = discoverAgents(ctx.cwd, "user").agents;
		for (const run of runs.values()) {
			if (run.status === "running" && treatTmuxAsAttachable && run.runtime?.backend === "tmux-tui") {
				try {
					const lease = await concurrency.adopt(run.id);
					const agent =
						agents.find((candidate) => candidate.name === run.agent) ??
						({
							name: run.agent,
							description: "restored interactive child",
							systemPrompt: "",
							source: "bundled",
							filePath: "<restored>",
						} satisfies AgentConfig);
					supervise(run, agent, ctx, lineageForRun(run), lease, (options) =>
						attachAgent(options, run.runtime as ChildRuntime),
					);
					continue;
				} catch (error) {
					run.error = error instanceof Error ? error.message : String(error);
				}
			}
			if (run.status === "running") {
				run.status = "failed";
				run.error = run.error || interruptedReason;
				run.question = undefined;
				run.finishedAt = Date.now();
				run.delivery = "pending";
				persist(run);
			}
			if (run.delivery === "pending") deliverCompletion(run);
		}
		prune();
		updateStatus();
	};

	pi.on("session_start", async (_event, ctx) => {
		currentCtx = ctx;
		tuiBridge?.start(ctx);
		await restoreActiveBranch(ctx, "Parent session restarted before completion.", true);
	});
	pi.on("session_tree", async (_event, ctx) => {
		currentCtx = ctx;
		await restoreActiveBranch(ctx, "Parent changed session branch before completion.", false);
	});
	pi.on("agent_settled", (_event, ctx) => {
		for (const run of runs.values()) {
			if (run.question && !run.question.delivered) deliverQuestion(run);
			if (run.delivery !== "pending") continue;
			if (acknowledgeDelivery(run)) continue;
			run.deliveryQueued = false;
			deliverCompletion(run);
		}
		if (tuiBridge) {
			const hasActiveChildren = [...runs.values()].some((run) => run.status === "running");
			tuiBridge.settle(childSettlement(ctx), hasActiveChildren);
		}
	});
	pi.on("session_shutdown", (event) => {
		branchGeneration++;
		for (const run of runs.values()) {
			if (event.reason === "reload" && run.runtime?.backend === "tmux-tui") run.child?.detach();
			else {
				run.cancelRequested = true;
				run.child?.abort();
			}
		}
		tuiBridge?.shutdown(event.reason);
		currentCtx = undefined;
	});

	if (childLineage) {
		const askParentGate = new AskParentTurnGate();
		pi.on("tool_call", (event, ctx) => askParentGate.intercept(event, currentAssistantMessage(ctx)));
		pi.on("input", (_event, ctx) => {
			if (tuiBridge?.blockHumanInputWhileWaiting(ctx)) return { action: "handled" as const };
			questionOpen = false;
		});
		pi.registerTool({
			name: "ask_parent",
			label: "Ask Parent",
			description: "Ask your direct parent one concise blocking question, then wait for its reply.",
			promptGuidelines: [
				"Use ask_parent instead of guessing when one decision materially blocks the child task.",
			],
			parameters: AskParentParams,
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _update, ctx) {
				if ((!tuiBridge && questionOpen) || tuiBridge?.isQuestionPending()) {
					throw new Error("A parent question is already pending.");
				}
				const question = assertBoundedText(params.question, "question", limits.questionBytes);
				questionOpen = !tuiBridge;
				const id = newRunId();
				tuiBridge?.publishParentQuestion(id, question);
				ctx.abort();
				return {
					content: [{ type: "text", text: "Question sent. End this turn and wait for the parent reply." }],
					details: { protocol: ASK_PARENT_PROTOCOL, id, question },
					terminate: true,
				};
			},
		});
	}

	const mayManageChildren =
		!childLineage || (childLineage.allowedChildren.length > 0 && childLineage.depth < limits.maxDepth);
	if (!mayManageChildren) return;

	pi.registerTool({
		name: "background_agent",
		label: "Background Agent",
		description:
			"Start substantial independent work in an isolated child. Writing profiles use Worktrunk worktrees by policy unless workspace=inherit; read-only profiles inherit the CWD. Returns an ID and pushes completion or one blocking question automatically. Starts are unlimited; global concurrency and delegation depth remain bounded.",
		promptGuidelines: [
			"Use background_agent only for substantial independent work where isolation or parallelism materially helps; never poll for completion.",
		],
		parameters: BackgroundAgentParams,
		async execute(_toolCallId, params, _signal, _update, ctx) {
			const task = assertBoundedText(params.task, "task", limits.taskBytes);
			const agents = discoverAgents(ctx.cwd, "user").agents;
			const known = new Set(agents.map((agent) => agent.name));
			const decision = decideDelegation({
				lineage: childLineage,
				target: params.agent,
				knownAgents: known,
				limits,
			});
			if (!decision.allowed) {
				return {
					content: [{ type: "text", text: decision.reason }],
					details: { protocol: CHILD_START_PROTOCOL, status: decision.code },
				};
			}
			const agent = agents.find((candidate) => candidate.name === params.agent) as AgentConfig;

			const requestedCwd = path.resolve(ctx.cwd, params.cwd ?? ctx.cwd);
			if (!fs.existsSync(requestedCwd) || !fs.statSync(requestedCwd).isDirectory())
				throw new Error(`Invalid child CWD: ${requestedCwd}`);
			const requestedModel = params.model ? assertBoundedText(params.model, "model", 512) : undefined;
			const model = resolveRequestedModel(requestedModel, ctx.modelRegistry.getAvailable());

			let id = newRunId();
			while (runs.has(id)) id = newRunId();
			const lineage = createChildLineage({
				parent: childLineage,
				runId: id,
				agent: agent.name,
				allowedChildren: agent.children ?? [],
				limits,
				registryPath,
			});
			let lease: ConcurrencyLease;
			try {
				lease = await concurrency.claim(id);
			} catch (error) {
				if (!(error instanceof GlobalConcurrencyLimitError)) throw error;
				const capacity = await concurrency.capacity();
				return {
					content: [
						{
							type: "text",
							text: `Global concurrency is full (${capacity.active}/${capacity.limit}). This is temporary; wait for an active child to settle.`,
						},
					],
					details: {
						protocol: CHILD_START_PROTOCOL,
						status: "temporarily_blocked",
						capacity,
						error: error instanceof Error ? error.message : String(error),
					},
				};
			}
			const workspaceMode = params.workspace ?? agent.workspace ?? "inherit";
			let workspace: WorktreeWorkspace;
			try {
				workspace = await prepareWorkspace({
					mode: workspaceMode,
					cwd: requestedCwd,
					agent: agent.name,
					id,
				});
			} catch (error) {
				await lease.release();
				throw error;
			}
			const run: ManagedRun = {
				id,
				agent: agent.name,
				task,
				cwd: workspace.cwd,
				workspace: workspace.mode,
				worktreeBranch: workspace.branch,
				worktreeCreated: workspace.created,
				workspaceSetup: workspace.setup,
				status: "running",
				activity: "starting",
				delivery: "none",
				startedAt: Date.now(),
				parentRunId: lineage.parentRunId,
				rootRunId: lineage.rootRunId,
				depth: lineage.depth,
				ancestry: lineage.ancestry,
				generation: branchGeneration,
			};
			runs.set(id, run);
			persist(run);
			updateStatus();

			const workspaceAgent =
				workspace.mode === "worktree"
					? {
							...agent,
							systemPrompt: `${agent.systemPrompt}\n\nRuntime workspace: Worktrunk linked worktree. Setup: ${workspaceSetupText(workspace)}. Keep all generated dependencies inside this worktree.`,
						}
					: agent;
			supervise(run, workspaceAgent, ctx, lineage, lease, runAgent, {
				model,
				thinking: params.thinking,
			});

			const workspaceText =
				workspace.mode === "worktree"
					? `Worktrunk worktree${workspace.branch ? ` (${workspace.branch})` : ""}\nsetup: ${workspaceSetupText(workspace)}`
					: "inherited cwd";
			const policySource = params.workspace
				? "call override"
				: agent.workspaceSource
					? `${agent.workspaceSource} profile policy`
					: "profile default";
			return {
				content: [{ type: "text", text: `started ${agent.name} ${id}\nworkspace: ${workspaceText}` }],
				details: {
					protocol: CHILD_START_PROTOCOL,
					status: "available",
					id,
					depth: lineage.depth,
					workspace,
					profile: {
						source: agent.source,
						filePath: agent.filePath,
						workspacePolicy: workspaceMode,
						workspacePolicySource: policySource,
					},
				},
			};
		},
	});

	pi.registerTool({
		name: "agent_control",
		label: "Agent Control",
		description: "Status, steer, reply to a pending question, or stop a direct child.",
		parameters: AgentControlParams,
		async execute(_toolCallId, params) {
			if (params.action === "status") {
				if (params.id) {
					const run = runs.get(params.id);
					if (!run || !ownsDirectChild(childLineage, run))
						throw new Error(`Unknown direct child: ${params.id}`);
					const result =
						run.status === "running"
							? compactStatus(run)
							: `${compactStatus(run)}\n${run.output ?? run.error ?? ""}`;
					return { content: [{ type: "text", text: truncateUtf8(result) }], details: {} };
				}
				const directRuns = [...runs.values()].filter((run) => ownsDirectChild(childLineage, run));
				const recent = directRuns.sort((a, b) => b.startedAt - a.startedAt).slice(0, MAX_RECENT_RUNS);
				const capacity = await concurrency.capacity();
				const active = directRuns.filter((run) => run.status === "running").length;
				const summary = [
					`runs: active ${active}, total ${directRuns.length}`,
					`global concurrency: ${capacity.active}/${capacity.limit}`,
					recent.length ? recent.map(compactStatus).join("\n") : "0 runs",
				].join("\n");
				const profiles = discoverAgents(currentCtx?.cwd ?? process.cwd(), "user")
					.agents.slice(0, MAX_RECENT_RUNS)
					.map((agent) => ({
						name: agent.name,
						source: agent.source,
						filePath: agent.filePath,
						workspacePolicy: agent.workspace ?? "inherit",
						workspacePolicySource: agent.workspaceSource ?? agent.source,
					}));
				return {
					content: [{ type: "text", text: summary }],
					details: { capacity, active, total: directRuns.length, profiles } as Record<string, unknown>,
				};
			}

			if (!params.id) throw new Error(`action=${params.action} requires id`);
			const run = runs.get(params.id);
			if (!run || !ownsDirectChild(childLineage, run)) throw new Error(`Unknown direct child: ${params.id}`);
			if (run.status !== "running") throw new Error(`Run ${params.id} is ${run.status}`);
			if (params.action === "stop") {
				run.cancelRequested = true;
				run.child?.abort();
				return { content: [{ type: "text", text: `stopping ${params.id}` }], details: {} };
			}
			if (!run.child) throw new Error(`Run ${params.id} is still starting.`);
			const message = assertBoundedText(params.message ?? "", "message", limits.replyBytes);
			if (params.action === "reply") {
				if (!run.question) throw new Error(`Run ${params.id} has no pending question.`);
				run.child.reply(run.question.id, message);
				run.question = undefined;
				run.activity = "running";
				persist(run);
				updateStatus();
				return { content: [{ type: "text", text: `replied ${params.id}` }], details: {} };
			}
			if (run.question) throw new Error(`Run ${params.id} is waiting; use action=reply.`);
			run.child.message(message);
			return { content: [{ type: "text", text: `sent ${params.id}` }], details: {} };
		},
	});
}
