import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import fastMode from "../extensions/fast-mode/index.js";
import * as stateModule from "../extensions/fast-mode/state.js";
import {
	type FastModeState,
	nextFastModeState,
	parseFastModeState,
	resolveServiceTier,
	withServiceTier,
} from "../extensions/fast-mode/state.js";

const on = (tier: FastModeState["tier"]): FastModeState => ({ version: 1, enabled: true, tier });
const off: FastModeState = { version: 1, enabled: false, tier: "priority" };

async function requestHook(state: FastModeState) {
	const spy = vi.spyOn(stateModule, "loadFastModeState").mockResolvedValue(state);
	try {
		const pi = { on: vi.fn(), registerCommand: vi.fn() };
		await fastMode(pi as unknown as ExtensionAPI);
		const hook = pi.on.mock.calls.find(([event]) => event === "before_provider_request")?.[1];
		return (model: Record<string, string>, usingOAuth = false) =>
			hook({ payload: { input: "test" } }, {
				model,
				modelRegistry: { isUsingOAuth: () => usingOAuth },
			} as unknown as ExtensionContext);
	} finally {
		spy.mockRestore();
	}
}

describe("Fast mode", () => {
	const openai = { provider: "openai", api: "openai-responses", id: "gpt-6-astra" };

	it("applies to Codex APIs and the ChatGPT login, never to OpenAI API keys", async () => {
		const send = await requestHook(on("priority"));
		const priority = { input: "test", service_tier: "priority" };
		expect(send({ provider: "openai-codex", api: "openai-codex-responses", id: "x" })).toEqual(priority);
		expect(send(openai, true)).toEqual(priority);
		expect(send(openai, false)).toBeUndefined();
		expect(send({ provider: "openrouter", api: "openai-responses", id: "x" }, true)).toBeUndefined();
	});

	it("sends Ultrafast only where offered and falls back to Fast elsewhere", async () => {
		const send = await requestHook(on("ultrafast"));
		expect(send(openai, true)).toEqual({ input: "test", service_tier: "ultrafast" });
		expect(send({ ...openai, id: "gpt-6-sol" }, true)).toEqual({ input: "test", service_tier: "priority" });
	});

	it("sends nothing while disabled", async () => {
		expect((await requestHook(off))(openai, true)).toBeUndefined();
		expect(resolveServiceTier(off, "gpt-6-astra")).toBeUndefined();
	});

	it("registers both commands", async () => {
		const pi = { on: vi.fn(), registerCommand: vi.fn() };
		const spy = vi.spyOn(stateModule, "loadFastModeState").mockResolvedValue(off);
		await fastMode(pi as unknown as ExtensionAPI);
		spy.mockRestore();
		expect(pi.registerCommand.mock.calls.map(([name]) => name)).toEqual(["fast", "ultrafast"]);
	});

	it("switches directly between tiers and toggles off on the same tier", () => {
		expect(nextFastModeState(off, "ultrafast", "")).toEqual(on("ultrafast"));
		expect(nextFastModeState(on("priority"), "ultrafast", "")).toEqual(on("ultrafast"));
		expect(nextFastModeState(on("ultrafast"), "ultrafast", "").enabled).toBe(false);
		expect(nextFastModeState(on("ultrafast"), "priority", "on")).toEqual(on("priority"));
		expect(nextFastModeState(on("ultrafast"), "priority", "off").enabled).toBe(false);
	});

	it("defaults to disabled for absent or invalid state", () => {
		expect(parseFastModeState(undefined)).toEqual(off);
		expect(parseFastModeState({ enabled: "yes", tier: "warp" })).toEqual(off);
	});

	it("restores older enabled files as Fast and a saved Ultrafast tier", () => {
		expect(parseFastModeState({ version: 99, enabled: true })).toEqual(on("priority"));
		expect(parseFastModeState({ enabled: true, tier: "ultrafast" })).toEqual(on("ultrafast"));
	});

	it("sets the tier without mutating the original payload", () => {
		const payload = { model: "gpt-5.6-sol", input: "hello" };
		expect(withServiceTier(payload, "priority")).toEqual({ ...payload, service_tier: "priority" });
		expect(payload).not.toHaveProperty("service_tier");
	});

	it("overrides a payload tier while enabled", () => {
		expect(withServiceTier({ service_tier: "default" }, "ultrafast")).toEqual({ service_tier: "ultrafast" });
	});

	it("leaves non-object transport payloads unchanged", () => {
		expect(withServiceTier("frame", "priority")).toBe("frame");
		expect(withServiceTier(null, "priority")).toBeNull();
	});
});
