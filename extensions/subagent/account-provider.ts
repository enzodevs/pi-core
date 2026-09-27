import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AccountService } from "../codex-accounts/service.ts";
import { AccountStore } from "../codex-accounts/store.ts";
import { CHILD_ACCOUNT_ENV } from "./account-inheritance.ts";

/** Loaded only for a child pinned to a vault account, before Pi resolves its model. */
export default function childAccountProvider(pi: ExtensionAPI): void {
	const accountId = process.env[CHILD_ACCOUNT_ENV];
	if (!accountId || accountId.length > 256 || /[\p{Cc}\p{Cf}]/u.test(accountId))
		throw new Error("Missing or invalid inherited Codex account.");
	const service = new AccountService(
		new AccountStore(join(homedir(), ".pi", "agent", "pi-core", "codex-accounts")),
	);
	pi.registerProvider(service.provider(accountId));
	pi.on("session_start", (_event, ctx) => {
		pi.appendEntry("codex-account-selection", { accountId, modelId: ctx.model?.id });
	});
}
