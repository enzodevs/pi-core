import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	acknowledgeCommand,
	type ChannelCommand,
	type ChannelResult,
	clearQuestion,
	listPendingCommands,
	openSidecarChannel,
	publishQuestion,
	publishReady,
	publishResult,
	readQuestion,
	readResult,
	type SidecarChannel,
	watchSidecar,
} from "./channel.ts";
import { HerdrStateReporter } from "./herdr-state.ts";
import type { SubagentLimits } from "./limits.ts";
import { truncateUtf8 } from "./limits.ts";
import type { ChildLineage } from "./protocol.ts";

const CONTROL_MESSAGE_TYPE = "pi-core-child-control";
const AUTO_EXIT_DELAY_MS = 2_500;

interface ChildSettlement {
	status: "complete" | "failed";
	output: string;
}

class TmuxChildBridge {
	private channel: SidecarChannel;
	private currentCtx: ExtensionContext | undefined;
	private stopWatching: (() => void) | undefined;
	private shutdownTimer: NodeJS.Timeout | undefined;
	private processing = false;
	private terminal = false;
	private terminalStatus: ChannelResult["status"] | undefined;
	private pendingQuestionId: string | undefined;
	private cancelled = false;
	private reconciliationTimer: NodeJS.Timeout | undefined;
	private readonly submitted = new Set<string>();
	private readonly reporter: HerdrStateReporter;

	constructor(
		private readonly pi: ExtensionAPI,
		lineage: ChildLineage,
		private readonly limits: SubagentLimits,
		directory: string,
		token: string,
		private readonly env: NodeJS.ProcessEnv,
	) {
		this.reporter = new HerdrStateReporter(env);
		this.channel = openSidecarChannel({ directory, token, lineage });
	}

	start(ctx: ExtensionContext): void {
		this.currentCtx = ctx;
		this.submitted.clear();
		this.cancelTimersAndWatcher();
		if (this.observeTerminal()) {
			if (this.shouldExit()) this.scheduleShutdown();
			return;
		}
		const question = readQuestion(this.channel);
		if (question && this.hasAppliedReply(ctx, question.id)) clearQuestion(this.channel, question.id);
		this.pendingQuestionId = question && !this.hasAppliedReply(ctx, question.id) ? question.id : undefined;
		this.stopWatching = watchSidecar(this.channel, () => this.reconcile());
		this.reconciliationTimer = setInterval(() => {
			try {
				if (!this.terminal && !this.cancelled) publishReady(this.channel);
				this.reconcile();
			} catch {
				this.currentCtx?.ui.notify("Child heartbeat could not be published; retrying.", "warning");
			}
		}, 1_000);
		this.reconciliationTimer.unref();
		publishReady(this.channel);
		this.running();
		this.reconcile();
	}

	stopForReload(): void {
		this.cancelTimersAndWatcher();
		this.currentCtx = undefined;
	}

	running(): void {
		this.reporter.state(
			this.pendingQuestionId ? "blocked" : "working",
			this.currentCtx?.sessionManager.getSessionFile(),
			this.pendingQuestionId ? "Waiting for parent reply" : undefined,
		);
	}

	reconcile(): void {
		void this.processCommands().catch(() => {
			this.currentCtx?.ui.notify("Parent command delivery could not be reconciled; retrying.", "warning");
		});
	}

	isQuestionPending(): boolean {
		return this.pendingQuestionId !== undefined;
	}

	publishParentQuestion(id: string, text: string): void {
		if (this.pendingQuestionId) throw new Error("A parent question is already pending.");
		const bounded = truncateUtf8(text, this.limits.questionBytes);
		publishQuestion(this.channel, { id, text: bounded, askedAt: Date.now() });
		this.pendingQuestionId = id;
		this.running();
	}

	blockHumanInputWhileWaiting(ctx: ExtensionContext): boolean {
		if (!this.pendingQuestionId) return false;
		ctx.ui.notify("This child is waiting for its parent reply; answer from the parent pane.", "warning");
		return true;
	}

	settle(settlement: ChildSettlement, hasActiveChildren: boolean, aborted = false): void {
		if (this.currentCtx && this.pendingQuestionId) this.acknowledgeApplied(this.currentCtx);
		if ((!aborted && (hasActiveChildren || this.pendingQuestionId)) || this.observeTerminal()) return;
		const output = truncateUtf8(
			settlement.output || "No final assistant output returned.",
			this.limits.handoffBytes,
		);
		this.publishTerminal({
			...settlement,
			status: this.cancelled ? "stopped" : settlement.status,
			output,
			finishedAt: Date.now(),
		});
		this.currentCtx?.ui.notify(
			settlement.status === "failed" && this.env.PI_CORE_SUBAGENT_HERDR
				? "Child failed; handoff delivered to parent. This terminal is retained for inspection."
				: "Final handoff delivered to the parent; this agent will exit shortly.",
			"info",
		);
		this.reporter.state(
			settlement.status === "complete" ? "idle" : "blocked",
			this.currentCtx?.sessionManager.getSessionFile(),
			settlement.status === "failed" ? "Child failed; inspect handoff in parent" : undefined,
		);
		if (this.shouldExit()) this.scheduleShutdown();
	}

	shutdown(reason: "quit" | "reload" | "new" | "resume" | "fork"): void {
		if (reason === "reload") {
			this.stopForReload();
			return;
		}
		this.cancelTimersAndWatcher();
		if (!this.observeTerminal()) {
			this.publishTerminal({
				status: this.cancelled ? "stopped" : "failed",
				output: this.cancelled ? "stopped" : "Child pane closed before completing its handoff.",
				finishedAt: Date.now(),
			});
		}
		this.reporter.release();
		this.currentCtx = undefined;
	}

	private observeTerminal(): boolean {
		if (this.terminal) return true;
		const result = readResult(this.channel);
		if (!result) return false;
		this.terminalStatus = result.status;
		this.terminal = true;
		return true;
	}

	private publishTerminal(result: Omit<ChannelResult, "version" | "token">): void {
		if (this.terminal) return;
		if (publishResult(this.channel, result)) {
			this.terminalStatus = result.status;
			this.terminal = true;
			return;
		}
		// Another process can win the create-once race between our read and write.
		if (this.observeTerminal()) return;
		throw new Error("Subagent terminal result already exists but is invalid or unreadable.");
	}

	private cancelTimersAndWatcher(): void {
		this.stopWatching?.();
		this.stopWatching = undefined;
		if (this.reconciliationTimer) clearInterval(this.reconciliationTimer);
		this.reconciliationTimer = undefined;
		if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
		this.shutdownTimer = undefined;
	}

	private shouldExit(): boolean {
		return !this.env.PI_CORE_SUBAGENT_HERDR || this.terminalStatus !== "failed";
	}

	private scheduleShutdown(): void {
		if (this.shutdownTimer) return;
		this.shutdownTimer = setTimeout(() => this.currentCtx?.shutdown(), AUTO_EXIT_DELAY_MS);
		this.shutdownTimer.unref();
	}

	private appliedCommandIds(ctx: ExtensionContext): Set<string> {
		const ids = new Set<string>();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom_message" || entry.customType !== CONTROL_MESSAGE_TYPE) continue;
			const details = entry.details as { commandId?: unknown } | undefined;
			if (typeof details?.commandId === "string") ids.add(details.commandId);
		}
		return ids;
	}

	private hasAppliedReply(ctx: ExtensionContext, questionId: string): boolean {
		return ctx.sessionManager.getBranch().some((entry) => {
			if (entry.type !== "custom_message" || entry.customType !== CONTROL_MESSAGE_TYPE) return false;
			const details = entry.details as { questionId?: unknown } | undefined;
			return details?.questionId === questionId;
		});
	}

	private acknowledgeApplied(ctx: ExtensionContext): Set<string> {
		const applied = this.appliedCommandIds(ctx);
		for (const command of listPendingCommands(this.channel)) {
			if (!applied.has(command.id)) continue;
			if (command.type === "reply") {
				if (this.pendingQuestionId === command.questionId) this.pendingQuestionId = undefined;
				clearQuestion(this.channel, command.questionId);
				this.running();
			}
			acknowledgeCommand(this.channel, command.id);
			this.submitted.delete(command.id);
		}
		return applied;
	}

	private async processCommands(): Promise<void> {
		if (this.processing) return;
		const ctx = this.currentCtx;
		if (!ctx || this.cancelled || readResult(this.channel)) return;
		this.processing = true;
		try {
			const applied = this.acknowledgeApplied(ctx);
			for (const command of listPendingCommands(this.channel)) {
				if (applied.has(command.id)) continue;
				// Native queue editing can drop custom steering messages. Idle means no
				// continuation remains: replay only unapplied commands, never duplicate a live queue.
				if (this.submitted.has(command.id) && ctx.isIdle()) this.submitted.delete(command.id);
				if (!this.submitted.has(command.id)) {
					try {
						await this.applyCommand(command, ctx);
					} catch (error) {
						this.submitted.delete(command.id);
						throw error;
					}
				}
				if (command.type === "cancel") break;
			}
			if (!this.cancelled) this.acknowledgeApplied(ctx);
		} finally {
			this.processing = false;
		}
	}

	private async applyCommand(command: ChannelCommand, ctx: ExtensionContext): Promise<void> {
		if (command.type === "cancel") {
			this.cancelled = true;
			acknowledgeCommand(this.channel, command.id);
			ctx.abort();
			setTimeout(() => ctx.shutdown(), 50).unref();
			return;
		}
		if (command.type === "reply") {
			if (!this.pendingQuestionId || command.questionId !== this.pendingQuestionId) return;
			this.submitted.add(command.id);
			this.pi.sendMessage(
				{
					customType: CONTROL_MESSAGE_TYPE,
					content: `Parent reply: ${command.text}\n\nContinue the assigned task using this answer.`,
					display: true,
					details: { commandId: command.id, questionId: command.questionId },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
			return;
		}
		this.submitted.add(command.id);
		this.pi.sendMessage(
			{
				customType: CONTROL_MESSAGE_TYPE,
				content: command.text,
				display: true,
				details: { commandId: command.id },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
	}
}

export function createTmuxChildBridge(
	pi: ExtensionAPI,
	lineage: ChildLineage,
	limits: SubagentLimits,
	env: NodeJS.ProcessEnv = process.env,
): TmuxChildBridge | undefined {
	const directory = env.PI_CORE_SUBAGENT_CHANNEL;
	const token = env.PI_CORE_SUBAGENT_CHANNEL_TOKEN;
	if (!directory && !token) return undefined;
	if (!directory || !token) throw new Error("Incomplete tmux subagent channel configuration.");
	return new TmuxChildBridge(pi, lineage, limits, directory, token, env);
}
