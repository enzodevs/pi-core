import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import fastMode from "../extensions/fast-mode/index.js";
import * as stateModule from "../extensions/fast-mode/state.js";
import { parseFastModeState, withPriorityServiceTier } from "../extensions/fast-mode/state.js";

describe("Fast mode", () => {
	it("preserves fast mode on the personal Codex provider without enabling it for other APIs", async () => {
		const spy = vi.spyOn(stateModule, "loadFastModeState").mockResolvedValue({ version: 1, enabled: true });
		try {
			const pi = { on: vi.fn(), registerCommand: vi.fn() };
			await fastMode(pi as unknown as ExtensionAPI);
			const hook = pi.on.mock.calls.find(([event]) => event === "before_provider_request")?.[1];
			for (const provider of ["openai-codex", "codex-accounts"]) {
				expect(
					hook({ payload: { input: "test" } }, {
						model: { provider, api: "openai-codex-responses" },
					} as ExtensionContext),
				).toEqual({ input: "test", service_tier: "priority" });
			}
			expect(
				hook({ payload: {} }, { model: { provider: "openai", api: "openai-responses" } } as ExtensionContext),
			).toBeUndefined();
		} finally {
			spy.mockRestore();
		}
	});
	it("defaults to disabled for absent or invalid state", () => {
		expect(parseFastModeState(undefined)).toEqual({ version: 1, enabled: false });
		expect(parseFastModeState({ enabled: "yes" })).toEqual({ version: 1, enabled: false });
	});

	it("restores an enabled preference", () => {
		expect(parseFastModeState({ version: 99, enabled: true })).toEqual({ version: 1, enabled: true });
	});

	it("adds priority processing without mutating the original payload", () => {
		const payload = { model: "gpt-5.6-sol", input: "hello" };
		expect(withPriorityServiceTier(payload)).toEqual({ ...payload, service_tier: "priority" });
		expect(payload).not.toHaveProperty("service_tier");
	});

	it("overrides a payload tier while enabled", () => {
		expect(withPriorityServiceTier({ service_tier: "default" })).toEqual({ service_tier: "priority" });
	});

	it("leaves non-object transport payloads unchanged", () => {
		expect(withPriorityServiceTier("frame")).toBe("frame");
		expect(withPriorityServiceTier(null)).toBeNull();
	});
});
