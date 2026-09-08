import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { MAX_JSON_BYTES } from "./bridge.js";
import type { OriginalReference } from "./originals.js";

interface Dependencies {
	compress: (text: string, signal?: AbortSignal) => Promise<string | undefined>;
	save: (text: string) => Promise<OriginalReference>;
}

export async function compactToolResult(
	event: ToolResultEvent,
	dependencies: Dependencies,
	signal?: AbortSignal,
): Promise<{ content: ToolResultEvent["content"] } | undefined> {
	// Start with bash stdout only. File reads/edits, images, multi-part results,
	// failed commands, truncated output, and historical messages are not touched.
	if (event.toolName !== "bash" || event.isError || event.content.length !== 1 || signal?.aborted) return;
	const part = event.content[0];
	if (part?.type !== "text") return;
	const details = event.details as
		| { truncation?: unknown; fullOutputPath?: unknown; exitCode?: unknown; code?: unknown }
		| undefined;
	if (
		details?.truncation ||
		details?.fullOutputPath ||
		(details?.exitCode !== undefined && details.exitCode !== 0) ||
		(details?.code !== undefined && details.code !== 0)
	)
		return;
	const text = part.text;
	const bytes = Buffer.byteLength(text);
	if (bytes < 8_192 || bytes > MAX_JSON_BYTES || !/^[\s]*[[{]/.test(text)) return;
	let pendingOriginal: OriginalReference | undefined;
	try {
		// Parsing is an eligibility check only: never reserialize through JS,
		// which would round large integers before Python can reject them.
		JSON.parse(text);
		const compacted = await dependencies.compress(text, signal);
		if (!compacted || signal?.aborted || Buffer.byteLength(compacted) > bytes * 0.75) return;
		pendingOriginal = await dependencies.save(text);
		if (signal?.aborted) return;
		const output = `Headroom lossless CSV-schema (arrays represented as tables). Original JSON: ${JSON.stringify(pendingOriginal.path)}\n${compacted}`;
		if (Buffer.byteLength(output) > bytes * 0.8) return;
		// Partial patch only: preserve details, error state, usage and exit status.
		const patch = { content: [{ ...part, text: output }] };
		pendingOriginal = undefined;
		return patch;
	} catch {
		return;
	} finally {
		// Do not retain a new sensitive artifact when no replacement was published.
		await pendingOriginal?.discard().catch(() => {});
	}
}
