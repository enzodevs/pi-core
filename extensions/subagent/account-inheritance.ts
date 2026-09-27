import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { PERSONAL_PROVIDER } from "../codex-accounts/service.ts";
import { PROVIDER } from "../codex-accounts/store.ts";

export const CHILD_ACCOUNT_ENV = "PI_CORE_CHILD_CODEX_ACCOUNT";

/** Account identity, never OAuth tokens, crosses the child process boundary. */
export function childAccountSelection(
	ctx: ExtensionContext,
	requested?: string,
): { model?: string; accountId?: string } {
	const model = requested ?? (ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
	const provider = model?.slice(0, model.indexOf("/"));
	if (provider !== PROVIDER && provider !== PERSONAL_PROVIDER) return { model };
	const entry = ctx.sessionManager
		?.getBranch?.()
		.slice()
		.reverse()
		.find((entry) => entry.type === "custom" && entry.customType === "codex-account-selection");
	const data =
		entry?.type === "custom"
			? (entry.data as { accountId?: unknown; defaultUnavailable?: boolean })
			: undefined;
	if (data?.defaultUnavailable)
		throw new Error("Parent Codex account is unavailable; select an account before delegation.");
	if (ctx.model?.provider === PERSONAL_PROVIDER || provider === PERSONAL_PROVIDER) {
		if (
			typeof data?.accountId !== "string" ||
			!data.accountId ||
			data.accountId.length > 256 ||
			/[\p{Cc}\p{Cf}]/u.test(data.accountId)
		) {
			throw new Error(
				"Cannot inherit the selected Codex account safely. Select it again in /codex-accounts.",
			);
		}
		return {
			model: `${PERSONAL_PROVIDER}/${model?.slice((model?.indexOf("/") ?? 0) + 1)}`,
			accountId: data.accountId,
		};
	}
	return { model };
}
