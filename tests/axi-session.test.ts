import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { axiPidFile, axiSessionName } from "../extensions/axi-session/core.js";
import axiSession from "../extensions/axi-session/index.js";

const SESSION_ENV = "CHROME_DEVTOOLS_AXI_SESSION";
const originalSession = process.env[SESSION_ENV];

afterEach(() => {
	if (originalSession === undefined) delete process.env[SESSION_ENV];
	else process.env[SESSION_ENV] = originalSession;
});

describe("axi session integration", () => {
	it("derives a stable, valid, opaque axi session name", () => {
		const first = axiSessionName("019b-session/id with unsafe characters");
		expect(first).toBe(axiSessionName("019b-session/id with unsafe characters"));
		expect(first).not.toBe(axiSessionName("another-session"));
		expect(first).toMatch(/^pi-[a-f0-9]{20}$/);
	});

	it("uses the documented named-session state path", () => {
		expect(axiPidFile("pi-abc", "/home/tester")).toBe(
			"/home/tester/.chrome-devtools-axi/sessions/pi-abc/bridge.pid",
		);
	});

	it("sets the environment for a session and restores the prior value on reload", async () => {
		process.env[SESSION_ENV] = "outside";
		const handlers = new Map<string, (...args: never[]) => unknown>();
		const pi = {
			on: vi.fn((name: string, handler: (...args: never[]) => unknown) => handlers.set(name, handler)),
			exec: vi.fn(),
		} as unknown as ExtensionAPI;
		axiSession(pi);

		const ctx = {
			sessionManager: { getSessionId: () => "session-123" },
		} as unknown as ExtensionContext;
		handlers.get("session_start")?.({ reason: "startup" } as never, ctx as never);
		expect(process.env[SESSION_ENV]).toBe(axiSessionName("session-123"));

		await handlers.get("session_shutdown")?.({ reason: "reload" } as never);
		expect(process.env[SESSION_ENV]).toBe("outside");
		expect(pi.exec).not.toHaveBeenCalled();
	});
});
