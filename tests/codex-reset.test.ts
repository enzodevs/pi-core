import { describe, expect, it, vi } from "vitest";
import { resetPiAccount } from "../extensions/codex-accounts/pi-account.js";
import { consumeReset } from "../extensions/codex-accounts/usage.js";

describe("Codex reset redemption", () => {
	it.each(["reset", "nothing_to_reset", "no_credit", "already_redeemed"])(
		"handles %s with one bounded, account-scoped POST",
		async (code) => {
			const request = vi.fn<typeof fetch>().mockResolvedValue(Response.json({ code }));
			expect(await consumeReset("secret", "account", AbortSignal.timeout(1000), request)).toBe(code);
			expect(request).toHaveBeenCalledTimes(1);
			const [url, options] = request.mock.calls[0]!;
			expect(url).toBe("https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume");
			expect(options).toMatchObject({
				method: "POST",
				redirect: "error",
				headers: {
					Authorization: "Bearer secret",
					"ChatGPT-Account-Id": "account",
					"Content-Type": "application/json",
				},
			});
			expect(JSON.parse(options?.body as string).redeem_request_id).toMatch(/^[0-9a-f-]{36}$/);
		},
	);

	it.each([
		Response.json({ code: "unknown" }),
		new Response("secret error", { status: 500 }),
		new Response("x".repeat(128 * 1024 + 1)),
	])("rejects unsafe or unsuccessful responses without retry", async (response) => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(response);
		await expect(consumeReset("secret", "account", AbortSignal.timeout(1000), request)).rejects.toThrow();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("does not retry an ambiguous transport failure", async () => {
		const request = vi.fn<typeof fetch>().mockRejectedValue(new Error("timeout"));
		await expect(consumeReset("secret", "account", AbortSignal.timeout(1000), request)).rejects.toThrow();
		expect(request).toHaveBeenCalledTimes(1);
	});

	it("refuses to redeem against a changed Pi login", async () => {
		const access = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "other" } })).toString("base64url")}.signature`;
		const registry = { getProviderAuth: vi.fn(async () => ({ auth: { apiKey: access } })) };
		const request = vi.fn<typeof consumeReset>();
		await expect(
			resetPiAccount("expected", registry as never, AbortSignal.timeout(1000), request),
		).rejects.toThrow("Account changed");
		expect(request).not.toHaveBeenCalled();
	});
});
