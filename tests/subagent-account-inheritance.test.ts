import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccountService } from "../extensions/codex-accounts/service.ts";
import { CHILD_ACCOUNT_ENV, childAccountSelection } from "../extensions/subagent/account-inheritance.ts";
import childAccountProvider from "../extensions/subagent/account-provider.ts";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.ts";
import { buildChildArgs } from "../extensions/subagent/runner.ts";

const context = (
	provider = "codex-accounts",
	entries: unknown[] = [
		{
			type: "custom",
			customType: "codex-account-selection",
			data: { accountId: "dev-account", modelId: "gpt-6-astra" },
		},
	],
) =>
	({
		model: { provider, id: "gpt-6-astra" },
		thinkingLevel: "low",
		sessionManager: { getBranch: () => entries },
	}) as unknown as ExtensionContext;

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe("Codex account inheritance", () => {
	it("preserves the selected account even with an explicit openai-codex model override", () => {
		expect(childAccountSelection(context(), "openai-codex/gpt-5.6-sol")).toEqual({
			model: "codex-accounts/gpt-5.6-sol",
			accountId: "dev-account",
		});
		expect(childAccountSelection(context())).toEqual({
			model: "codex-accounts/gpt-6-astra",
			accountId: "dev-account",
		});
	});
	it("takes the last account on the active session branch", () => {
		expect(
			childAccountSelection(
				context("codex-accounts", [
					{ type: "custom", customType: "codex-account-selection", data: { accountId: "old" } },
					{ type: "custom", customType: "codex-account-selection", data: { accountId: "new" } },
				]),
			).accountId,
		).toBe("new");
	});
	it("never silently falls back when the parent selection is missing or unavailable", () => {
		expect(() => childAccountSelection(context("codex-accounts", []))).toThrow("Cannot inherit");
		expect(() =>
			childAccountSelection(
				context("openai-codex", [
					{ type: "custom", customType: "codex-account-selection", data: { defaultUnavailable: true } },
				]),
			),
		).toThrow("unavailable");
	});
	it("leaves non-Codex providers and the explicitly active Pi login alone", () => {
		expect(childAccountSelection(context(), "openrouter/openai/gpt-5.6-sol")).toEqual({
			model: "openrouter/openai/gpt-5.6-sol",
		});
		expect(childAccountSelection(context("openai-codex"))).toEqual({ model: "openai-codex/gpt-6-astra" });
	});
	it.each(["rpc", "tui"] as const)(
		"loads the pinned account provider before model resolution in %s",
		(mode) => {
			const args = buildChildArgs(
				{
					ctx: context(),
					model: "openai-codex/gpt-5.6-sol",
					thinking: "low",
					agent: {
						name: "worker",
						description: "worker",
						systemPrompt: "work",
						source: "bundled",
						filePath: "/worker.md",
						tools: ["read"],
					},
					lineage: {
						version: 1,
						runId: "abc",
						rootRunId: "abc",
						parentRunId: null,
						agent: "worker",
						depth: 1,
						ancestry: ["abc"],
						allowedChildren: [],
						limits: DEFAULT_SUBAGENT_LIMITS,
						registryPath: "/tmp/registry.json",
					},
				},
				"/tmp/system.md",
				undefined,
				{ mode },
			);
			expect(args).toContain("codex-accounts/gpt-5.6-sol");
			expect(args.some((arg) => arg.endsWith("/account-provider.ts"))).toBe(true);
			expect(args).not.toContain("dev-account");
			expect(args).not.toContain("openai-codex/gpt-5.6-sol");
		},
	);
	it("registers the account synchronously and persists identity for reload and nested children", () => {
		vi.stubEnv(CHILD_ACCOUNT_ENV, "dev-account");
		const provider = { id: "codex-accounts" };
		const create = vi.spyOn(AccountService.prototype, "provider").mockReturnValue(provider as never);
		const registerProvider = vi.fn();
		const appendEntry = vi.fn();
		let start: ((_event: unknown, ctx: ExtensionContext) => void) | undefined;
		childAccountProvider({
			registerProvider,
			appendEntry,
			on: (_name: string, fn: typeof start) => {
				start = fn;
			},
		} as unknown as ExtensionAPI);
		expect(create).toHaveBeenCalledWith("dev-account");
		expect(registerProvider).toHaveBeenCalledWith(provider);
		start?.({}, context());
		expect(appendEntry).toHaveBeenCalledWith("codex-account-selection", {
			accountId: "dev-account",
			modelId: "gpt-6-astra",
		});
	});
	it("refuses to load the inherited provider without an account reference", () => {
		vi.stubEnv(CHILD_ACCOUNT_ENV, "");
		expect(() => childAccountProvider({} as ExtensionAPI)).toThrow("Missing or invalid");
	});
});
