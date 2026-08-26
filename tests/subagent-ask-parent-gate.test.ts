import {
	type AgentContext,
	type AgentEvent,
	type AgentLoopConfig,
	type AgentMessage,
	type AgentTool,
	runAgentLoop,
} from "@earendil-works/pi-agent-core";
import {
	type AssistantMessage,
	type AssistantMessageEvent,
	EventStream,
	type Message,
	type Model,
} from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { describe, expect, it } from "vitest";
import { AskParentTurnGate } from "../extensions/subagent/ask-parent-gate.js";
import { ASK_PARENT_PROTOCOL, RpcEventTracker } from "../extensions/subagent/protocol.js";

class MockAssistantStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected stream event.");
			},
		);
	}
}

function model(): Model<"openai-responses"> {
	return {
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8_192,
		maxTokens: 2_048,
	};
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "openai-responses",
		provider: "openai",
		model: "mock",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: Date.now(),
	};
}

function toLlm(messages: AgentMessage[]): Message[] {
	return messages.filter(
		(message) => message.role === "user" || message.role === "assistant" || message.role === "toolResult",
	) as Message[];
}

describe("ask_parent parallel tool gate", () => {
	it.each(["before", "after"] as const)(
		"blocks a mutating sibling listed %s ask_parent before parallel execution",
		async (position) => {
			const gate = new AskParentTurnGate();
			let askExecutions = 0;
			let mutationExecutions = 0;
			let llmCalls = 0;
			const controller = new AbortController();
			const empty = Type.Object({});
			const askTool: AgentTool<typeof empty, Record<string, unknown>> = {
				name: "ask_parent",
				label: "Ask Parent",
				description: "ask",
				parameters: empty,
				executionMode: "sequential",
				async execute() {
					askExecutions++;
					controller.abort();
					return {
						content: [{ type: "text", text: "waiting" }],
						details: {
							protocol: ASK_PARENT_PROTOCOL,
							id: "question-1",
							question: "Which API?",
						},
						terminate: true,
					};
				},
			};
			const editTool: AgentTool<typeof empty, Record<string, never>> = {
				name: "edit",
				label: "Edit",
				description: "mutate",
				parameters: empty,
				async execute() {
					mutationExecutions++;
					return { content: [{ type: "text", text: "mutated" }], details: {} };
				},
			};
			const askCall = { type: "toolCall" as const, id: "ask-1", name: "ask_parent", arguments: {} };
			const editCall = { type: "toolCall" as const, id: "edit-1", name: "edit", arguments: {} };
			const calls = position === "before" ? [editCall, askCall] : [askCall, editCall];
			const context: AgentContext = { systemPrompt: "", messages: [], tools: [askTool, editTool] };
			const config: AgentLoopConfig = {
				model: model(),
				convertToLlm: toLlm,
				toolExecution: "parallel",
				beforeToolCall: async ({ assistantMessage, toolCall, args }) =>
					gate.intercept(
						{
							type: "tool_call",
							toolName: toolCall.name,
							toolCallId: toolCall.id,
							input: args as Record<string, unknown>,
						},
						assistantMessage,
					),
			};
			const events: AgentEvent[] = [];

			await runAgentLoop(
				[{ role: "user", content: "ask before changing anything", timestamp: Date.now() }],
				context,
				config,
				(event) => {
					events.push(event);
				},
				controller.signal,
				() => {
					llmCalls++;
					const stream = new MockAssistantStream();
					queueMicrotask(() => {
						const message = assistant(calls);
						stream.push({ type: "done", reason: "toolUse", message });
					});
					return stream;
				},
			);

			expect(askExecutions).toBe(1);
			expect(mutationExecutions).toBe(0);
			expect(llmCalls).toBe(1);
			const tracker = new RpcEventTracker(128);
			const askEnd = events.find(
				(event) => event.type === "tool_execution_end" && event.toolCallId === "ask-1",
			);
			expect(tracker.consume(askEnd)).toMatchObject({ type: "question" });
			expect(tracker.consume({ type: "agent_settled" })).toEqual({ type: "settled", waiting: true });
			const editEnd = events.find(
				(event) => event.type === "tool_execution_end" && event.toolCallId === "edit-1",
			);
			if (position === "before") {
				expect(editEnd).toMatchObject({ isError: true });
				expect(JSON.stringify(editEnd)).toContain("ask_parent must be the only tool");
			} else {
				expect(editEnd).toBeUndefined();
			}
		},
	);
});
