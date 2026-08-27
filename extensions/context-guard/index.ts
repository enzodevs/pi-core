import * as path from "node:path";
import { type ExtensionAPI, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { ArtifactStore } from "./artifacts.ts";
import {
	type ContextProjectionStats,
	DEFAULT_CONTEXT_GUARD_CONFIG,
	projectToolContext,
} from "./compressor.ts";

const STATUS_ID = "pi-core-context-guard";
const LOOKUP_TOOL = "context_lookup";
const ENTRY_TYPE = "pi-core-context-artifact";

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KiB`;
}

function emptyStats(): ContextProjectionStats {
	return { toolResults: 0, compressedResults: 0, originalBytes: 0, projectedBytes: 0 };
}

function textContent(content: ReadonlyArray<{ type: string; text?: string }>): string {
	return content
		.filter(
			(block): block is { type: "text"; text: string } =>
				block.type === "text" && typeof block.text === "string",
		)
		.map((block) => block.text)
		.join("\n");
}

function fullOutputPath(details: unknown): string | undefined {
	if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
	const value = (details as { fullOutputPath?: unknown }).fullOutputPath;
	return typeof value === "string" && path.isAbsolute(value) ? value : undefined;
}

export default function contextGuard(pi: ExtensionAPI): void {
	let latest = emptyStats();
	let store: ArtifactStore | undefined;
	let sessionId = "";
	const artifacts = new Map<string, string>();

	const activateLookup = () => {
		const active = pi.getActiveTools();
		if (!active.includes(LOOKUP_TOOL)) pi.setActiveTools([...active, LOOKUP_TOOL]);
	};

	pi.registerTool({
		name: LOOKUP_TOOL,
		label: "Context Lookup",
		description:
			"Search one indexed oversized tool result. Returns bounded matching lines with line numbers.",
		parameters: Type.Object({
			artifact: Type.String({
				minLength: 16,
				maxLength: 16,
				description: "Artifact ID from a guarded result",
			}),
			query: Type.String({
				minLength: 2,
				maxLength: 256,
				description: "Words or identifiers that must occur",
			}),
			limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 30, description: "Maximum matching lines" })),
		}),
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const result = store?.search(
				params.artifact,
				ctx.sessionManager.getSessionId(),
				params.query,
				params.limit,
			);
			if (!result) throw new Error(`Unknown context artifact: ${params.artifact}.`);
			return {
				content: [{ type: "text", text: result.text }],
				details: {
					artifact: result.artifact.id,
					matches: result.matches,
					storedBytes: result.artifact.storedBytes,
					originalBytes: result.artifact.originalBytes,
					truncated: result.artifact.truncated,
				},
			};
		},
	});

	pi.on("session_start", (_event, ctx) => {
		latest = emptyStats();
		sessionId = ctx.sessionManager.getSessionId();
		store = new ArtifactStore({ root: path.join(getAgentDir(), "pi-core", "context-artifacts") });
		store.cleanup();
		artifacts.clear();
		for (const entry of ctx.sessionManager.getBranch()) {
			if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
			const data = entry.data as { toolCallId?: unknown; artifact?: unknown };
			if (typeof data.toolCallId !== "string" || typeof data.artifact !== "string") continue;
			if (store.get(data.artifact, sessionId)) artifacts.set(data.toolCallId, data.artifact);
		}
		const active = pi.getActiveTools().filter((name) => name !== LOOKUP_TOOL);
		pi.setActiveTools(active);
		if (artifacts.size > 0) activateLookup();
	});

	pi.on("tool_result", (event) => {
		if (!store || artifacts.has(event.toolCallId)) return;
		const content = textContent(event.content);
		const artifact = store.store({
			toolCallId: event.toolCallId,
			toolName: event.toolName,
			sessionId,
			content,
			fullOutputPath: fullOutputPath(event.details),
		});
		if (!artifact) return;
		artifacts.set(event.toolCallId, artifact.metadata.id);
		pi.appendEntry(ENTRY_TYPE, { toolCallId: event.toolCallId, artifact: artifact.metadata.id });
		activateLookup();
	});

	pi.on("context", (event) => {
		const projection = projectToolContext(event.messages, DEFAULT_CONTEXT_GUARD_CONFIG, artifacts);
		latest = projection.stats;
		return { messages: projection.messages };
	});

	pi.registerCommand("context-guard", {
		description: "Show the current tool-output context projection",
		handler: async (_args, ctx) => {
			const saved = Math.max(0, latest.originalBytes - latest.projectedBytes);
			const percent = latest.originalBytes > 0 ? Math.round((saved / latest.originalBytes) * 100) : 0;
			ctx.ui.notify(
				latest.toolResults === 0
					? `Context guard: no tool results · ${artifacts.size} indexed artifacts.`
					: `Context guard: ${latest.compressedResults}/${latest.toolResults} results compressed · ${formatBytes(
							latest.originalBytes,
						)} → ${formatBytes(latest.projectedBytes)} (${percent}% saved) · ${artifacts.size} artifacts · ${formatBytes(
							DEFAULT_CONTEXT_GUARD_CONFIG.totalToolBytes,
						)} rolling budget`,
				"info",
			);
			ctx.ui.setStatus(STATUS_ID, undefined);
		},
	});
}
