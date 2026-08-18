import { describe, expect, it } from "vitest";
import { parseFastModeState, withPriorityServiceTier } from "../extensions/fast-mode/state.js";

describe("Fast mode", () => {
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
