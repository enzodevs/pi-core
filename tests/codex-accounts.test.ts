import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createModels, type OAuthCredential } from "@earendil-works/pi-ai";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import codexAccounts from "../extensions/codex-accounts/index.js";
import { AccountService, PERSONAL_PROVIDER } from "../extensions/codex-accounts/service.js";
import { AccountStore, PROVIDER } from "../extensions/codex-accounts/store.js";
import { fetchUsage, parseUsage, usageSummary } from "../extensions/codex-accounts/usage.js";

const directories: string[] = [];
afterEach(async () => {
	await Promise.all(directories.splice(0).map((p) => rm(p, { recursive: true, force: true })));
});
async function fixture() {
	const directory = await mkdtemp(join(tmpdir(), "pi-codex-test-"));
	directories.push(directory);
	return { directory, store: new AccountStore(directory) };
}
function credential(id = "one", expires = Date.now() + 3_600_000): OAuthCredential {
	return { type: "oauth", accountId: id, access: `secret-${id}`, refresh: `refresh-${id}`, expires };
}

describe("personal Codex vault", () => {
	it("persists defaults across stores and clears them on removal", async () => {
		const { store, directory } = await fixture();
		expect(await store.defaultAccount()).toBeUndefined();
		await store.add("One", credential());
		await store.setDefaultAccount("one");
		expect(await new AccountStore(directory).defaultAccount()).toBe("one");
		await expect(store.setDefaultAccount("missing")).rejects.toThrow("removida");
		expect(await store.defaultAccount()).toBe("one");
		await store.setDefaultAccount(undefined);
		expect(await store.defaultAccount()).toBeUndefined();
		await store.setDefaultAccount("one");
		await store.remove("one");
		expect(await store.defaultAccount()).toBeUndefined();
	});

	it("rejects malformed default references", async () => {
		const { store, directory } = await fixture();
		await writeFile(
			join(directory, "accounts.json"),
			JSON.stringify({ version: 1, accounts: [], defaultAccountId: 12 }),
		);
		await expect(store.defaultAccount()).rejects.toThrow("padrão inválida");
	});

	it("renames saved accounts without changing their credentials", async () => {
		const { store, directory } = await fixture();
		const original = credential();
		await store.add("Old name", original);
		await store.rename("one", " New name ", "vault");
		expect(await new AccountStore(directory).list()).toEqual([{ id: "one", label: "New name" }]);
		expect(await store.credentials("one").read(PROVIDER)).toEqual(original);
		await expect(store.rename("missing", "Name", "vault")).rejects.toThrow("removida");
		await expect(store.rename("one", "\u001b[31m", "vault")).rejects.toThrow("inválido");
	});
	it("persists Pi aliases by account identity without copying tokens or leaking the alias to another login", async () => {
		const { store, directory } = await fixture();
		await store.rename("host-id", "Admin Redapro", "pi");
		const reopened = new AccountStore(directory);
		expect(await reopened.piLabel("host-id")).toBe("Admin Redapro");
		expect(await reopened.piLabel("other-id")).toBeUndefined();
		expect(await reopened.piLabel("toString")).toBeUndefined();
		expect(await reopened.list()).toEqual([]);
		expect(JSON.parse(await readFile(join(directory, "accounts.json"), "utf8"))).toEqual({
			version: 1,
			accounts: [],
			piLabels: { "host-id": "Admin Redapro" },
		});
	});
	it("preserves aliases and credentials across concurrent rename and refresh", async () => {
		const { store, directory } = await fixture();
		await store.add("One", credential());
		const other = new AccountStore(directory);
		await Promise.all([
			store.rename("one", "Renamed", "vault"),
			other.credentials("one").modify(PROVIDER, async () => ({ ...credential(), refresh: "rotated" })),
			other.rename("host", "Admin Redapro", "pi"),
		]);
		expect(await store.list()).toEqual([{ id: "one", label: "Renamed" }]);
		expect(await store.credentials("one").read(PROVIDER)).toMatchObject({ refresh: "rotated" });
		expect(await store.piLabel("host")).toBe("Admin Redapro");
	});
	it("persists any number of accounts privately, without secrets in list", async () => {
		const { store, directory } = await fixture();
		for (const id of ["one", "two", "three", "four"]) await store.add(id, credential(id));
		expect(await new AccountStore(directory).list()).toEqual(
			["one", "two", "three", "four"].map((id) => ({ id, label: id })),
		);
		expect((await stat(directory)).mode & 0o777).toBe(0o700);
		expect((await stat(join(directory, "accounts.json"))).mode & 0o777).toBe(0o600);
		await store.remove("two");
		expect(await store.list()).toHaveLength(3);
	});
	it("rejects duplicate identities and control sequences without overwriting", async () => {
		const { store } = await fixture();
		await store.add("First", credential());
		await expect(store.add("Duplicate", credential())).rejects.toThrow("já cadastrada");
		await expect(store.add("\x1b[31m", credential("two"))).rejects.toThrow();
		expect(await store.list()).toEqual([{ id: "one", label: "First" }]);
	});
	it("never replaces a damaged vault with an empty one", async () => {
		const { store, directory } = await fixture();
		await writeFile(join(directory, "accounts.json"), "broken");
		await expect(store.add("First", credential())).rejects.toThrow();
		expect(await readFile(join(directory, "accounts.json"), "utf8")).toBe("broken");
	});
	it("serializes concurrent writers from independent store instances", async () => {
		const { store, directory } = await fixture();
		await Promise.all([
			store.add("One", credential()),
			new AccountStore(directory).add("Two", credential("two")),
		]);
		expect(await store.list()).toHaveLength(2);
	});
	it("rolls back failed token rotation and rejects changed identities", async () => {
		const { store } = await fixture();
		await store.add("One", credential());
		await expect(
			store.credentials("one").modify(PROVIDER, async () => {
				throw new Error("failed");
			}),
		).rejects.toThrow();
		await expect(store.credentials("one").modify(PROVIDER, async () => credential("two"))).rejects.toThrow(
			"Identidade",
		);
		expect(await store.credentials("one").read(PROVIDER)).toMatchObject({
			access: "secret-one",
			refresh: "refresh-one",
		});
	});
	it("persists successful token rotation even when cancellation arrives just afterwards", async () => {
		const { store } = await fixture();
		await store.add("One", credential());
		const controller = new AbortController();
		await store.credentials("one").modify(
			PROVIDER,
			async () => {
				controller.abort();
				return { ...credential(), refresh: "rotated" };
			},
			{ signal: controller.signal },
		);
		expect(await store.credentials("one").read(PROVIDER)).toMatchObject({ refresh: "rotated" });
	});
	it("refreshes a rotated token only once across concurrent requests", async () => {
		const { store, directory } = await fixture();
		await store.add("One", credential("one", 0));
		const refresh = vi.fn(async () => credential());
		const base = openaiCodexProvider();
		if (!base.auth.oauth) throw new Error("OAuth missing");
		const provider = { ...base, auth: { oauth: { ...base.auth.oauth, refresh } } };
		const clients = [store, new AccountStore(directory)].map((s) => {
			const m = createModels({ credentials: s.credentials("one") });
			m.setProvider(provider);
			return m;
		});
		await Promise.all(clients.map((m) => m.getAuth(PROVIDER)));
		expect(refresh).toHaveBeenCalledTimes(1);
	});
	it("routes to the chosen account independently of normal Pi credentials, and fails closed after removal", async () => {
		const { store } = await fixture();
		await store.add("One", credential());
		await store.add("Two", credential("two"));
		const service = new AccountService(store);
		const models = createModels();
		models.setProvider(service.provider("two"));
		expect((await models.getAuth(PERSONAL_PROVIDER))?.auth.apiKey).toBe("secret-two");
		expect(
			service
				.provider("two")
				.getModels()
				.every((m) => m.provider === PERSONAL_PROVIDER),
		).toBe(true);
		await store.remove("two");
		await expect(models.getAuth(PERSONAL_PROVIDER)).rejects.toThrow("Não foi possível autenticar");
	});
	it("does not expose token endpoint errors", async () => {
		const { store } = await fixture();
		await store.add("One", credential("one", 0));
		const base = openaiCodexProvider();
		if (!base.auth.oauth) throw new Error("OAuth missing");
		const service = new AccountService(store, {
			...base,
			auth: {
				oauth: {
					...base.auth.oauth,
					refresh: async () => {
						throw new Error("SECRET_REFRESH_TOKEN");
					},
				},
			},
		});
		const models = createModels();
		models.setProvider(service.provider("one"));
		try {
			await models.getAuth(PERSONAL_PROVIDER);
			throw new Error("expected failure");
		} catch (e) {
			expect(String(e)).not.toContain("SECRET_REFRESH_TOKEN");
			expect(String(e)).toContain("Não foi possível autenticar");
		}
	});
});

const window = (seconds: number, used = 25) => ({
	limit_window_seconds: seconds,
	used_percent: used,
	reset_at: 1_900_000_000,
});
describe("Codex limits", () => {
	it.each([0, 3])("shows the explicit available reset count (%s)", (available_count) => {
		const usage = parseUsage({ rate_limit: {}, rate_limit_reset_credits: { available_count } });
		expect(usage.availableResets).toBe(available_count);
		expect(usageSummary(usage)).toContain(`resets: ${available_count}`);
	});
	it.each([undefined, null, -1, 1.5, "3", Number.NaN, Number.MAX_SAFE_INTEGER + 1])(
		"does not invent a reset count from missing/invalid metadata (%s)",
		(available_count) => {
			const usage = parseUsage({ rate_limit: {}, rate_limit_reset_credits: { available_count } });
			expect(usage.availableResets).toBeUndefined();
			expect(usageSummary(usage)).toContain("resets: não informado");
		},
	);
	it("retains reset counts when quota windows are absent", () => {
		const usage = parseUsage({ rate_limit_reset_credits: { available_count: 2 } });
		expect(usage.windows).toEqual([]);
		expect(usage.availableResets).toBe(2);
		expect(usageSummary(usage)).toContain("semana: não informado");
	});
	it("identifies weekly limits by duration rather than window order", () => {
		const usage = parseUsage({
			rate_limit: { primary_window: window(604800), secondary_window: window(18000, 90) },
		});
		expect(usageSummary(usage)).toBe("5h: 10% livre · semana: 75% livre · resets: não informado");
		expect(usage.windows[0]?.resetAt).toBe(1_900_000_000_000);
	});
	it("does not invent missing windows or accept malformed numbers", () => {
		expect(usageSummary(parseUsage({ rate_limit: {} }))).toContain("semana: não informado");
		for (const data of [
			null,
			{},
			{ rate_limit: { primary_window: window(18000, -1) } },
			{ rate_limit: { primary_window: window(18000, Number.NaN) } },
		])
			expect(() => parseUsage(data)).toThrow();
	});
	it("uses the fixed endpoint with correct account headers and refuses redirects", async () => {
		const request = vi.fn<typeof fetch>().mockResolvedValue(
			new Response(
				JSON.stringify({
					rate_limit: { primary_window: window(604800) },
					rate_limit_reset_credits: { available_count: 3 },
				}),
			),
		);
		expect((await fetchUsage("access", "account", AbortSignal.timeout(1000), request)).availableResets).toBe(
			3,
		);
		expect(request).toHaveBeenCalledTimes(1);
		expect(request).toHaveBeenCalledWith(
			"https://chatgpt.com/backend-api/wham/usage",
			expect.objectContaining({
				redirect: "error",
				method: "GET",
				headers: expect.objectContaining({ Authorization: "Bearer access", "ChatGPT-Account-Id": "account" }),
			}),
		);
	});
	it("bounds responses and never exposes server error bodies", async () => {
		await expect(
			fetchUsage(
				"a",
				"b",
				AbortSignal.timeout(1000),
				vi.fn<typeof fetch>().mockResolvedValue(new Response("SECRET", { status: 401 })),
			),
		).rejects.toThrow("Login expirado");
		await expect(
			fetchUsage(
				"a",
				"b",
				AbortSignal.timeout(1000),
				vi.fn<typeof fetch>().mockResolvedValue(new Response("x".repeat(128 * 1024 + 1))),
			),
		).rejects.toThrow("grande demais");
	});
});

it("registers only user controls and session-state restoration, no model-facing surfaces", () => {
	const pi = { registerCommand: vi.fn(), registerShortcut: vi.fn(), on: vi.fn() };
	codexAccounts(pi as unknown as ExtensionAPI);
	expect(pi.registerCommand).toHaveBeenCalledWith("codex-accounts", expect.any(Object));
	expect(pi.registerShortcut).toHaveBeenCalledWith("ctrl+alt+a", expect.any(Object));
	expect(pi.on.mock.calls.map(([event]) => event)).toEqual(["session_start", "input"]);
});
