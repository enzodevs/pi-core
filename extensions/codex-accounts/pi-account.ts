import type { Credential } from "@earendil-works/pi-ai";
import { type ModelRegistry, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { PROVIDER } from "./store.js";
import { consumeReset, fetchUsage } from "./usage.js";

export interface PiAccount {
	id: string;
	label: string;
	source: "pi";
}

function tokenAccountId(access: string): string | undefined {
	try {
		const payload = JSON.parse(Buffer.from(access.split(".")[1] ?? "", "base64url").toString("utf8"));
		const id = payload?.["https://api.openai.com/auth"]?.chatgpt_account_id;
		return typeof id === "string" && id.length > 0 ? id : undefined;
	} catch {
		return undefined;
	}
}

/** Reference the host login, never copy its tokens into the personal vault. */
export function readPiAccount(
	read: () => Credential | undefined = () => readStoredCredential(PROVIDER),
): PiAccount | undefined {
	const credential = read();
	if (credential?.type !== "oauth" || typeof credential.access !== "string" || !credential.access)
		return undefined;
	const id = tokenAccountId(credential.access) ?? credential.accountId;
	if (typeof id !== "string" || !id || id.length > 256 || /[\p{Cc}\p{Cf}]/u.test(id)) return undefined;
	return { id, label: "Login padrão do Pi", source: "pi" };
}

/** Pi remains the sole owner of refresh/rotation of auth.json credentials. */
export async function fetchPiAccountUsage(
	id: string,
	registry: Pick<ModelRegistry, "getProviderAuth">,
	signal: AbortSignal,
	request: typeof fetchUsage = fetchUsage,
) {
	try {
		return await request(await piAccess(id, registry, signal), id, signal);
	} catch {
		throw new Error("Limites do login padrão indisponíveis. Atualize o menu ou confira /login.");
	}
}

export async function resetPiAccount(
	id: string,
	registry: Pick<ModelRegistry, "getProviderAuth">,
	signal: AbortSignal,
	request: typeof consumeReset = consumeReset,
) {
	return request(await piAccess(id, registry, signal), id, signal);
}

async function piAccess(id: string, registry: Pick<ModelRegistry, "getProviderAuth">, signal: AbortSignal) {
	signal.throwIfAborted();
	const result = await registry.getProviderAuth(PROVIDER);
	signal.throwIfAborted();
	const access = result?.auth.apiKey;
	// /login or another process may have changed accounts since the menu was built.
	// Never attribute another account's quota to this row or send a mismatched header.
	if (!access || tokenAccountId(access) !== id) throw new Error("Account changed");
	return access;
}
