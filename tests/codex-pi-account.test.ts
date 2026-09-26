import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OAuthCredential } from "@earendil-works/pi-ai";
import { readStoredCredential } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { fetchPiAccountUsage, readPiAccount } from "../extensions/codex-accounts/pi-account.js";
import { PROVIDER } from "../extensions/codex-accounts/store.js";
import type { fetchUsage } from "../extensions/codex-accounts/usage.js";

const token = (id: string) =>
	`header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.signature`;
const credential = (id: string): OAuthCredential => ({
	type: "oauth",
	access: token(id),
	refresh: "SECRET_REFRESH",
	expires: 0,
	accountId: id,
});

describe("existing Pi account reference", () => {
	it("reads an expired existing OAuth login without changing auth.json or returning tokens", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-account-test-"));
		try {
			const path = join(directory, "auth.json");
			const original = JSON.stringify({
				[PROVIDER]: credential("existing"),
				unrelated: { type: "api_key", key: "OTHER_SECRET" },
			});
			await writeFile(path, original, { mode: 0o600 });
			const account = readPiAccount(() => readStoredCredential(PROVIDER, path));
			expect(account).toEqual({ id: "existing", label: "Login padrão do Pi", source: "pi" });
			expect(JSON.stringify(account)).not.toContain("SECRET");
			expect(await readFile(path, "utf8")).toBe(original);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("ignores absent, API-key, and malformed credentials", () => {
		expect(readPiAccount(() => undefined)).toBeUndefined();
		expect(readPiAccount(() => ({ type: "api_key", key: "SECRET" }))).toBeUndefined();
		expect(
			readPiAccount(() => ({ ...credential("one"), access: "broken", accountId: undefined })),
		).toBeUndefined();
		expect(readPiAccount(() => ({ ...credential("one"), access: "" }))).toBeUndefined();
	});
	it("uses the token identity used by Codex requests, rather than a stale metadata field", () => {
		expect(readPiAccount(() => ({ ...credential("current"), accountId: "stale" }))?.id).toBe("current");
	});
	it("resolves and refreshes through Pi, then queries usage using the resolved token", async () => {
		const current = token("one");
		const registry = { getProviderAuth: vi.fn(async () => ({ auth: { apiKey: current }, source: "OAuth" })) };
		const request = vi.fn<typeof fetchUsage>().mockResolvedValue({ windows: [], checkedAt: 1 });
		const signal = AbortSignal.timeout(1000);
		expect(await fetchPiAccountUsage("one", registry, signal, request)).toEqual({
			windows: [],
			checkedAt: 1,
		});
		expect(registry.getProviderAuth).toHaveBeenCalledWith(PROVIDER);
		expect(request).toHaveBeenCalledWith(current, "one", signal);
	});
	it("does not attribute usage to an account replaced by another login", async () => {
		const registry = { getProviderAuth: vi.fn(async () => ({ auth: { apiKey: token("other") } })) };
		const request = vi.fn<typeof fetchUsage>();
		await expect(fetchPiAccountUsage("one", registry, AbortSignal.timeout(1000), request)).rejects.toThrow(
			"indisponíveis",
		);
		expect(request).not.toHaveBeenCalled();
	});
	it("sanitizes native auth failures and does not resolve after cancellation", async () => {
		const registry = {
			getProviderAuth: vi.fn(async () => {
				throw new Error("SECRET_REFRESH");
			}),
		};
		await expect(fetchPiAccountUsage("one", registry, AbortSignal.timeout(1000))).rejects.toThrow(
			"Limites do login padrão indisponíveis",
		);
		registry.getProviderAuth.mockClear();
		await expect(fetchPiAccountUsage("one", registry, AbortSignal.abort())).rejects.toThrow("indisponíveis");
		expect(registry.getProviderAuth).not.toHaveBeenCalled();
	});
});
