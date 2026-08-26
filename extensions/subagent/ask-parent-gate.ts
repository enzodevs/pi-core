import type {
	ExtensionContext,
	MessageEndEvent,
	ToolCallEvent,
	ToolCallEventResult,
} from "@earendil-works/pi-coding-agent";

const BLOCK_REASON = "Blocked: ask_parent must be the only tool executed in its turn.";
type AssistantMessage = Extract<MessageEndEvent["message"], { role: "assistant" }>;

/**
 * Return the complete assistant message Pi persisted before tool preflight.
 * This is authoritative even when another extension replaced message_end.
 */
export function currentAssistantMessage(
	ctx: Pick<ExtensionContext, "sessionManager">,
): AssistantMessage | undefined {
	const branch = ctx.sessionManager.getBranch();
	for (let index = branch.length - 1; index >= 0; index--) {
		const entry = branch[index];
		if (entry.type === "message" && entry.message.role === "assistant") return entry.message;
	}
	return undefined;
}

/**
 * Blocks every sibling in a tool-call batch containing ask_parent.
 *
 * Pi preflights parallel calls sequentially and starts execution only after all
 * calls are prepared. Inspecting the already-persisted complete assistant
 * message makes this order-independent: even a mutating call listed before
 * ask_parent is blocked before Pi starts any prepared call.
 */
export class AskParentTurnGate {
	intercept(event: ToolCallEvent, message: AssistantMessage | undefined): ToolCallEventResult | undefined {
		if (!message) return undefined;
		const calls = message.content.filter((part) => part.type === "toolCall");
		const askParent = calls.find((call) => call.name === "ask_parent");
		if (!askParent || event.toolCallId === askParent.id) return undefined;
		if (!calls.some((call) => call.id === event.toolCallId)) return undefined;
		return { block: true, reason: BLOCK_REASON, terminate: true };
	}
}
