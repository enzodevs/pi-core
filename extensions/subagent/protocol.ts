import type { SubagentLimits } from "./limits.ts";
import { validateSubagentLimits } from "./limits.ts";

export const ASK_PARENT_PROTOCOL = "pi-core.ask-parent.v1";
export const CHILD_START_PROTOCOL = "pi-core.child-start.v1";
export const COMPLETION_PROTOCOL = "pi-core.child-complete.v1";
export const COMPLETION_MESSAGE_TYPE = "pi-core-background-agent-result";

const RUN_ID_PATTERN = /^[a-f0-9]{8,32}$/;
const AGENT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;

export interface ChildLineage {
	version: 1;
	runId: string;
	rootRunId: string;
	parentRunId: string | null;
	agent: string;
	depth: number;
	ancestry: string[];
	allowedChildren: string[];
	limits: SubagentLimits;
	registryPath: string;
}

export interface RunOwnership {
	id: string;
	parentRunId: string | null;
	depth: number;
	ancestry: string[];
}

export interface PendingQuestion {
	id: string;
	text: string;
	askedAt: number;
	delivered: boolean;
}

function validAgentNames(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 32 &&
		value.every((name) => typeof name === "string" && AGENT_NAME_PATTERN.test(name))
	);
}

export function encodeChildLineage(lineage: ChildLineage): string {
	return Buffer.from(JSON.stringify(lineage), "utf8").toString("base64url");
}

export function decodeChildLineage(raw: string | undefined): ChildLineage | null {
	if (!raw) return null;
	let value: unknown;
	try {
		value = JSON.parse(Buffer.from(raw, "base64url").toString("utf8"));
	} catch {
		return null;
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return null;
	const item = value as Partial<ChildLineage>;
	const limits = validateSubagentLimits(item.limits);
	if (
		item.version !== 1 ||
		typeof item.runId !== "string" ||
		!RUN_ID_PATTERN.test(item.runId) ||
		typeof item.rootRunId !== "string" ||
		!RUN_ID_PATTERN.test(item.rootRunId) ||
		(item.parentRunId !== null &&
			(typeof item.parentRunId !== "string" || !RUN_ID_PATTERN.test(item.parentRunId))) ||
		typeof item.agent !== "string" ||
		!AGENT_NAME_PATTERN.test(item.agent) ||
		!Number.isInteger(item.depth) ||
		!Array.isArray(item.ancestry) ||
		!item.ancestry.every((id) => typeof id === "string" && RUN_ID_PATTERN.test(id)) ||
		new Set(item.ancestry).size !== item.ancestry.length ||
		!validAgentNames(item.allowedChildren) ||
		!limits ||
		typeof item.registryPath !== "string" ||
		!item.registryPath.startsWith("/")
	) {
		return null;
	}
	if (
		item.depth !== item.ancestry.length ||
		item.depth < 1 ||
		item.depth > limits.maxDepth ||
		item.ancestry[item.ancestry.length - 1] !== item.runId ||
		item.rootRunId !== item.ancestry[0] ||
		(item.depth === 1 ? item.parentRunId !== null : item.parentRunId !== item.ancestry[item.depth - 2])
	) {
		return null;
	}
	return { ...(item as ChildLineage), limits };
}

export function createChildLineage(params: {
	parent: ChildLineage | null;
	runId: string;
	agent: string;
	allowedChildren: string[];
	limits: SubagentLimits;
	registryPath: string;
}): ChildLineage {
	const ancestry = [...(params.parent?.ancestry ?? []), params.runId];
	return {
		version: 1,
		runId: params.runId,
		rootRunId: params.parent?.rootRunId ?? params.runId,
		parentRunId: params.parent?.runId ?? null,
		agent: params.agent,
		depth: ancestry.length,
		ancestry,
		allowedChildren: [...new Set(params.allowedChildren)],
		limits: { ...params.limits },
		registryPath: params.registryPath,
	};
}

export type DelegationDecision =
	| { allowed: true }
	| { allowed: false; code: "unknown" | "permission" | "depth" | "children" | "self"; reason: string };

export function decideDelegation(params: {
	lineage: ChildLineage | null;
	target: string;
	knownAgents: ReadonlySet<string>;
	childrenStarted: number;
	limits: SubagentLimits;
}): DelegationDecision {
	if (!params.knownAgents.has(params.target)) {
		return { allowed: false, code: "unknown", reason: `Unknown agent: ${params.target}.` };
	}
	if (params.childrenStarted >= params.limits.maxChildrenPerRun) {
		return {
			allowed: false,
			code: "children",
			reason: `Child limit reached (${params.limits.maxChildrenPerRun} per parent run).`,
		};
	}
	if ((params.lineage?.depth ?? 0) >= params.limits.maxDepth) {
		return {
			allowed: false,
			code: "depth",
			reason: `Delegation depth limit reached (${params.limits.maxDepth}).`,
		};
	}
	if (params.lineage?.agent === params.target) {
		return { allowed: false, code: "self", reason: `Agent ${params.target} cannot delegate to itself.` };
	}
	if (params.lineage && !params.lineage.allowedChildren.includes(params.target)) {
		return {
			allowed: false,
			code: "permission",
			reason: `Agent ${params.lineage.agent} may delegate only to: ${params.lineage.allowedChildren.join(", ") || "none"}.`,
		};
	}
	return { allowed: true };
}

export function ownsDirectChild(parent: ChildLineage | null, run: RunOwnership): boolean {
	const expectedParent = parent?.runId ?? null;
	const expectedDepth = (parent?.depth ?? 0) + 1;
	const expectedPrefix = parent?.ancestry ?? [];
	return (
		run.parentRunId === expectedParent &&
		run.depth === expectedDepth &&
		run.ancestry.length === expectedDepth &&
		expectedPrefix.every((id, index) => run.ancestry[index] === id) &&
		run.ancestry[run.ancestry.length - 1] === run.id
	);
}

export type RpcProtocolEvent =
	| { type: "question"; question: PendingQuestion }
	| { type: "nested_started"; id: string }
	| { type: "nested_finished"; id: string }
	| { type: "settled"; waiting: boolean; output?: string; error?: string };

function asRecord(value: unknown): Record<string, unknown> | null {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: null;
}

export class RpcEventTracker {
	private finalOutput = "";
	private finalError: string | undefined;
	private pendingQuestion: PendingQuestion | undefined;
	private readonly nestedChildren = new Set<string>();

	constructor(private readonly questionByteLimit: number) {}

	consume(value: unknown): RpcProtocolEvent | null {
		const event = asRecord(value);
		if (!event || typeof event.type !== "string") return null;

		if (event.type === "message_end") {
			const message = asRecord(event.message);
			if (!message) return null;
			if (message.role === "assistant" && Array.isArray(message.content)) {
				const text = message.content
					.flatMap((part) => {
						const block = asRecord(part);
						return block?.type === "text" && typeof block.text === "string" ? [block.text] : [];
					})
					.join("\n\n");
				if (text) this.finalOutput = text;
				this.finalError =
					message.stopReason === "error" && typeof message.errorMessage === "string"
						? message.errorMessage
						: undefined;
			}
			if (message.role === "custom" && message.customType === COMPLETION_MESSAGE_TYPE) {
				const details = asRecord(message.details);
				if (details?.protocol === COMPLETION_PROTOCOL && typeof details.id === "string") {
					this.nestedChildren.delete(details.id);
					return { type: "nested_finished", id: details.id };
				}
			}
			return null;
		}

		if (event.type === "tool_execution_end") {
			const result = asRecord(event.result);
			const details = asRecord(result?.details);
			if (
				event.toolName === "ask_parent" &&
				details?.protocol === ASK_PARENT_PROTOCOL &&
				typeof details.id === "string" &&
				typeof details.question === "string"
			) {
				if (Buffer.byteLength(details.question, "utf8") > this.questionByteLimit) {
					throw new Error("Child emitted an oversized parent question.");
				}
				this.pendingQuestion = {
					id: details.id,
					text: details.question,
					askedAt: Date.now(),
					delivered: false,
				};
				return { type: "question", question: { ...this.pendingQuestion } };
			}
			if (
				event.toolName === "background_agent" &&
				event.isError !== true &&
				details?.protocol === CHILD_START_PROTOCOL &&
				typeof details.id === "string"
			) {
				this.nestedChildren.add(details.id);
				return { type: "nested_started", id: details.id };
			}
			return null;
		}

		if (event.type === "agent_settled") {
			const waiting = this.pendingQuestion !== undefined || this.nestedChildren.size > 0;
			return {
				type: "settled",
				waiting,
				...(waiting ? {} : this.finalError ? { error: this.finalError } : { output: this.finalOutput }),
			};
		}
		return null;
	}

	acceptReply(questionId: string): void {
		if (!this.pendingQuestion || this.pendingQuestion.id !== questionId) {
			throw new Error(`Question ${questionId} is not pending.`);
		}
		this.pendingQuestion = undefined;
	}
}
