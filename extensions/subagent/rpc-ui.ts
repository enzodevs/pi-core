import type {
	ExtensionContext,
	RpcExtensionUIRequest,
	RpcExtensionUIResponse,
} from "@earendil-works/pi-coding-agent";

/** A child may request approval, but only the user's UI can grant it. */
export async function forwardChildDialog(
	request: RpcExtensionUIRequest,
	ctx: ExtensionContext,
	agent: string,
	signal: AbortSignal,
): Promise<RpcExtensionUIResponse | undefined> {
	if (!["select", "confirm", "input", "editor"].includes(request.method)) return;
	const cancelled = { type: "extension_ui_response", id: request.id, cancelled: true } as const;
	if (!ctx.hasUI || signal.aborted) return cancelled;
	const response = { type: "extension_ui_response", id: request.id } as const;
	let value: string | undefined;
	switch (request.method) {
		case "confirm": {
			const confirmed = await ctx.ui.confirm(`[${agent}] ${request.title}`, request.message, {
				signal,
				timeout: request.timeout,
			});
			return signal.aborted ? cancelled : { ...response, confirmed };
		}
		case "select":
			value = await ctx.ui.select(`[${agent}] ${request.title}`, request.options, {
				signal,
				timeout: request.timeout,
			});
			break;
		case "input":
			value = await ctx.ui.input(`[${agent}] ${request.title}`, request.placeholder, {
				signal,
				timeout: request.timeout,
			});
			break;
		case "editor":
			value = await ctx.ui.editor(`[${agent}] ${request.title}`, request.prefill);
			break;
	}
	return signal.aborted || value === undefined ? cancelled : { ...response, value };
}
