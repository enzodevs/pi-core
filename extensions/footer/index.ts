import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

interface UsageLike {
	cost?: { total?: number };
}

interface MessageLike {
	role?: string;
	usage?: UsageLike;
}

interface EntryLike {
	type?: string;
	message?: MessageLike;
	usage?: UsageLike;
}

export function messageCost(message: MessageLike): number {
	return message.role === "assistant" || message.role === "toolResult"
		? (message.usage?.cost?.total ?? 0)
		: 0;
}

export function entryCost(entry: EntryLike): number {
	if (entry.type === "message" && entry.message) return messageCost(entry.message);
	if (entry.type === "compaction" || entry.type === "branch_summary") {
		return entry.usage?.cost?.total ?? 0;
	}
	return 0;
}

function branchCost(ctx: ExtensionContext): number {
	let total = 0;
	for (const entry of ctx.sessionManager.getBranch()) total += entryCost(entry as EntryLike);
	return total;
}

function formatCost(cost: number): string {
	if (cost <= 0) return "";
	if (cost < 0.01) return `$${cost.toFixed(3)}`;
	if (cost < 10) return `$${cost.toFixed(2)}`;
	return `$${cost.toFixed(0)}`;
}

function contextLabel(ctx: ExtensionContext): string {
	const usage = ctx.getContextUsage();
	if (!usage || usage.percent === null) return "ctx —";
	return `ctx ${Math.round(usage.percent)}%`;
}

export function chooseFooterParts(
	width: number,
	parts: { model: string; branch?: string; context: string; cost?: string; statuses?: string[] },
): { left: string; right: string } {
	const separator = " · ";
	const dividerWidth = 3;
	const statuses = (parts.statuses ?? []).filter(Boolean);
	const leftParts = [parts.model, parts.branch ? `git:${parts.branch}` : ""].filter(Boolean);
	const rightParts = [parts.context, parts.cost ?? "", ...statuses].filter(Boolean);

	const measure = () =>
		visibleWidth(leftParts.join(separator)) + dividerWidth + visibleWidth(rightParts.join(separator));

	if (measure() > width && parts.cost) rightParts.splice(rightParts.indexOf(parts.cost), 1);
	if (measure() > width && parts.branch) leftParts.splice(1, 1);
	if (measure() > width && statuses.length > 0) rightParts.splice(rightParts.indexOf(parts.context), 1);
	if (measure() > width) {
		const statusText = statuses.join(separator);
		const statusWidth = visibleWidth(statusText);
		if (statuses.length > 0 && statusWidth + dividerWidth + 1 > width) {
			return { left: "", right: truncateToWidth(statusText, width, "…") };
		}
		const rightWidth = visibleWidth(rightParts.join(separator));
		leftParts[0] = truncateToWidth(parts.model, Math.max(1, width - dividerWidth - rightWidth), "");
	}

	return { left: leftParts.join(separator), right: rightParts.join(separator) };
}

export default function minimalFooter(pi: ExtensionAPI): void {
	let sessionCost = 0;
	let activeTui: { requestRender(): void } | undefined;

	pi.on("message_end", (event) => {
		sessionCost += messageCost(event.message as MessageLike);
		activeTui?.requestRender();
	});

	pi.on("agent_end", (_event, ctx) => {
		sessionCost = branchCost(ctx);
		activeTui?.requestRender();
	});
	pi.on("model_select", () => activeTui?.requestRender());
	pi.on("thinking_level_select", () => activeTui?.requestRender());
	pi.on("session_tree", (_event, ctx) => {
		sessionCost = branchCost(ctx);
		activeTui?.requestRender();
	});

	pi.on("session_start", (_event, ctx) => {
		sessionCost = branchCost(ctx);
		ctx.ui.setFooter((tui, theme, footerData) => {
			activeTui = tui;
			const unsubscribe = footerData.onBranchChange(() => tui.requestRender());

			return {
				dispose() {
					unsubscribe();
					if (activeTui === tui) activeTui = undefined;
				},
				invalidate() {},
				render(width: number): string[] {
					if (width <= 0) return [""];
					const model = ctx.model?.id ?? "no model";
					const thinking = pi.getThinkingLevel();
					const modelLabel = `◇ ${model}${thinking === "off" ? "" : ` · ${thinking}`}`;
					const statuses = [...footerData.getExtensionStatuses().values()];
					const parts = chooseFooterParts(width, {
						model: modelLabel,
						branch: footerData.getGitBranch() ?? undefined,
						context: contextLabel(ctx),
						cost: formatCost(sessionCost) || undefined,
						statuses,
					});

					const left = theme.fg("muted", parts.left);
					const right = theme.fg("dim", parts.right);
					if (!parts.left) return [truncateToWidth(right, width, "")];
					if (!parts.right) return [truncateToWidth(left, width, "")];

					const divider = theme.fg("dim", " │ ");
					const paddingWidth = Math.max(0, width - visibleWidth(parts.left) - visibleWidth(parts.right) - 3);
					return [truncateToWidth(`${left}${divider}${" ".repeat(paddingWidth)}${right}`, width, "")];
				},
			};
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		activeTui = undefined;
		ctx.ui.setFooter(undefined);
	});
}
