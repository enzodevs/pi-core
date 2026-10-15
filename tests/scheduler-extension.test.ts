import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import schedulerExtension from "../extensions/scheduler/index.js";

const mocks = vi.hoisted(() => ({ root: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => mocks.root,
}));
interface Tool {
	exposure: string;
	parameters: unknown;
	execute(
		id: string,
		params: unknown,
		signal: undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: { text: string }[] }>;
}
const shutdowns: (() => Promise<void>)[] = [];
afterEach(async () => {
	for (const shutdown of shutdowns.splice(0)) await shutdown();
	if (mocks.root) rmSync(mocks.root, { recursive: true, force: true });
	vi.restoreAllMocks();
});
function harness(session = "one") {
	let sessionId = session;
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	let tool!: Tool;
	const notify = vi.fn();
	const sendMessage = vi.fn();
	const ctx = {
		cwd: mocks.root,
		isIdle: () => true,
		ui: { notify },
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
	schedulerExtension({
		on: (event: string, hook: (event: unknown, ctx: ExtensionContext) => unknown) => hooks.set(event, hook),
		registerTool: (value: Tool) => {
			tool = value;
		},
		registerCommand: vi.fn(),
		sendMessage,
	} as unknown as ExtensionAPI);
	const emit = async (name: string) => {
		await hooks.get(name)?.({}, ctx);
	};
	shutdowns.push(() => emit("session_shutdown"));
	return {
		emit,
		notify,
		sendMessage,
		get tool() {
			return tool;
		},
		switchTo(value: string) {
			sessionId = value;
			return emit("session_start");
		},
		call: (params: unknown) => tool.execute("test", params, undefined, undefined, ctx),
	};
}

describe("scheduler extension lifecycle", () => {
	it("runs a real shell check and delivers a bounded failure follow-up", async () => {
		mocks.root = mkdtempSync(join(tmpdir(), "pi-scheduler-shell-"));
		const time = Date.now();
		const clock = vi.spyOn(Date, "now").mockReturnValue(time);
		const h = harness();
		await h.emit("session_start");
		await h.call({
			action: "create",
			job: {
				when: "+30s",
				prompt: "Investigate the failure",
				command: `"${process.execPath}" -e "console.log('scheduler failure');process.exit(7)"`,
			},
		});
		clock.mockReturnValue(time + 30001);
		await h.emit("agent_settled");
		await vi.waitFor(async () => {
			await h.emit("agent_settled");
			expect(h.sendMessage).toHaveBeenCalledTimes(1);
		});
		expect(h.sendMessage).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({ content: expect.stringContaining("failed exit=7") }),
			{ deliverAs: "followUp", triggerTurn: true },
		);
		expect(h.sendMessage.mock.calls[0][0].content).toContain("scheduler failure");
		expect(h.notify).not.toHaveBeenCalled();
	});
	it("is deferred, persists across reload, and isolates different sessions", async () => {
		mocks.root = mkdtempSync(join(tmpdir(), "pi-scheduler-wiring-"));
		const h = harness();
		await h.emit("session_start");
		expect(h.tool.exposure).toBe("deferred");
		expect(Buffer.byteLength(JSON.stringify(h.tool.parameters))).toBeLessThan(4096);
		await h.call({ action: "create", job: { when: "+5m", prompt: "check" } });
		expect((await h.call({ action: "list" })).content[0].text).toContain("active");
		await h.emit("session_start");
		expect((await h.call({ action: "list" })).content[0].text).toContain("active");
		await h.switchTo("two");
		expect((await h.call({ action: "list" })).content[0].text).toBe("0 jobs");
		await h.switchTo("one");
		expect((await h.call({ action: "list" })).content[0].text).toContain("active");
	});
	it("rejects a competing owner and can acquire after the owner shuts down", async () => {
		mocks.root = mkdtempSync(join(tmpdir(), "pi-scheduler-lock-"));
		const first = harness();
		const second = harness();
		await first.emit("session_start");
		await second.emit("session_start");
		await expect(second.call({ action: "list" })).rejects.toThrow("already being held");
		await first.emit("session_shutdown");
		await second.emit("session_start");
		expect((await second.call({ action: "list" })).content[0].text).toBe("0 jobs");
	});
	it("rejects malformed action combinations", async () => {
		mocks.root = mkdtempSync(join(tmpdir(), "pi-scheduler-input-"));
		const h = harness();
		await h.emit("session_start");
		await expect(h.call({ action: "create" })).rejects.toThrow("requires job");
		await expect(h.call({ action: "pause" })).rejects.toThrow("id is required");
		await expect(h.call({ action: "list", job: {} })).rejects.toThrow("only accepted for create");
	});
});
