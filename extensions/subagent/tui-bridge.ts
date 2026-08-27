import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	acknowledgeCommand,
	type ChannelCommand,
	clearQuestion,
	listPendingCommands,
	openSidecarChannel,
	publishQuestion,
	publishResult,
	readQuestion,
	readResult,
	type SidecarChannel,
	watchSidecar,
} from "./channel.ts";
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
	private pendingQuestionId: string | undefined;
	private cancelled = false;

	constructor(
		private readonly pi: ExtensionAPI,
		lineage: ChildLineage,
		private readonly limits: SubagentLimits,
		directory: string,
		token: string,
	) {
		this.channel = openSidecarChannel({ directory, token, lineage });
	}

	start(ctx: ExtensionContext): void {
		this.currentCtx = ctx;
		this.cancelTimersAndWatcher();
		const terminal = readResult(this.channel);
		if (terminal) {
			this.scheduleShutdown();
			return;
		}
		const question = readQuestion(this.channel);
		if (question && this.hasAppliedReply(ctx, question.id)) clearQuestion(this.channel, question.id);
		this.pendingQuestionId = question && !this.hasAppliedReply(ctx, question.id) ? question.id : undefined;
		this.stopWatching = watchSidecar(this.channel, () => void this.processCommands());
		void this.processCommands();
	}

	stopForReload(): void {
		this.cancelTimersAndWatcher();
		this.currentCtx = undefined;
	}

	isQuestionPending(): boolean {
		return this.pendingQuestionId !== undefined;
	}

	publishParentQuestion(id: string, text: string): void {
		if (this.pendingQuestionId) throw new Error("A parent question is already pending.");
		const bounded = truncateUtf8(text, this.limits.questionBytes);
		publishQuestion(this.channel, { id, text: bounded, askedAt: Date.now() });
		this.pendingQuestionId = id;
	}

	blockHumanInputWhileWaiting(ctx: ExtensionContext): boolean {
		if (!this.pendingQuestionId) return false;
		ctx.ui.notify("This child is waiting for its parent reply; answer from the parent pane.", "warning");
		return true;
	}

	settle(settlement: ChildSettlement, hasActiveChildren: boolean): void {
		if (hasActiveChildren || this.pendingQuestionId || readResult(this.channel)) return;
		const output = truncateUtf8(
			settlement.output || "No final assistant output returned.",
			this.limits.handoffBytes,
		);
		publishResult(this.channel, { ...settlement, output, finishedAt: Date.now() });
		this.currentCtx?.ui.notify(
			"Final handoff delivered to the parent; this pane will close shortly.",
			"info",
		);
		this.scheduleShutdown();
	}

	shutdown(reason: "quit" | "reload" | "new" | "resume" | "fork"): void {
		if (reason === "reload") {
			this.stopForReload();
			return;
		}
		this.cancelTimersAndWatcher();
		if (!readResult(this.channel)) {
			publishResult(this.channel, {
				status: this.cancelled ? "stopped" : "failed",
				output: this.cancelled ? "stopped" : "Child pane closed before completing its handoff.",
				finishedAt: Date.now(),
			});
		}
		this.currentCtx = undefined;
	}

	private cancelTimersAndWatcher(): void {
		this.stopWatching?.();
		this.stopWatching = undefined;
		if (this.shutdownTimer) clearTimeout(this.shutdownTimer);
		this.shutdownTimer = undefined;
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

	private async processCommands(): Promise<void> {
		if (this.processing) return;
		const ctx = this.currentCtx;
		if (!ctx || readResult(this.channel)) return;
		this.processing = true;
		try {
			const applied = this.appliedCommandIds(ctx);
			for (const command of listPendingCommands(this.channel)) {
				if (applied.has(command.id)) {
					acknowledgeCommand(this.channel, command.id);
					continue;
				}
				await this.applyCommand(command, ctx);
			}
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
			this.pi.sendMessage(
				{
					customType: CONTROL_MESSAGE_TYPE,
					content: `Parent reply: ${command.text}\n\nContinue the assigned task using this answer.`,
					display: true,
					details: { commandId: command.id, questionId: command.questionId },
				},
				{ deliverAs: "steer", triggerTurn: true },
			);
			this.pendingQuestionId = undefined;
			clearQuestion(this.channel, command.questionId);
			acknowledgeCommand(this.channel, command.id);
			return;
		}
		this.pi.sendMessage(
			{
				customType: CONTROL_MESSAGE_TYPE,
				content: command.text,
				display: true,
				details: { commandId: command.id },
			},
			{ deliverAs: "steer", triggerTurn: true },
		);
		acknowledgeCommand(this.channel, command.id);
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
	return new TmuxChildBridge(pi, lineage, limits, directory, token);
}
