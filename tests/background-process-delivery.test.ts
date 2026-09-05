import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import backgroundProcesses from "../extensions/background-process/index.js";
import type { ProcessResult, runBackgroundProcess } from "../extensions/background-process/process.js";

const mocks = vi.hoisted(() => ({ root: "", launch: vi.fn<typeof runBackgroundProcess>() }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => mocks.root,
}));
vi.mock("../extensions/background-process/process.js", async (original) => ({
	...(await original<typeof import("../extensions/background-process/process.js")>()),
	runBackgroundProcess: mocks.launch,
}));

interface Notification {
	customType: string;
	content: string;
	details: { ids: string[] };
}
interface Entry {
	type: string;
	customType: string;
	data?: { id: string; delivery: string };
	details?: { id?: string; ids?: string[] };
}
interface Tool {
	name: string;
	execute: (
		id: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		update: undefined,
		ctx: ExtensionContext,
	) => Promise<{ content: { text: string }[]; details: Record<string, unknown> }>;
}

function harness(entries: Entry[] = []) {
	let idle = false;
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, Tool>();
	const jobs: { finish: (result: ProcessResult) => void; done: Promise<ProcessResult> }[] = [];
	mocks.launch.mockImplementation(() => {
		let finish!: (result: ProcessResult) => void;
		const done = new Promise<ProcessResult>((resolve) => {
			finish = resolve;
		});
		jobs.push({ finish, done });
		return done;
	});
	const sendMessage = vi.fn((message: Notification) => {
		entries.push({ type: "custom_message", ...message });
	});
	const ctx = {
		cwd: mocks.root,
		isIdle: () => idle,
		ui: { setStatus: vi.fn(), notify: vi.fn() },
		sessionManager: { getSessionId: () => "test-session", getBranch: () => entries },
	} as unknown as ExtensionContext;
	backgroundProcesses({
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) =>
			hooks.set(event, handler),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		appendEntry: (customType: string, data: Entry["data"]) =>
			entries.push({ type: "custom", customType, data }),
		sendMessage,
	} as unknown as ExtensionAPI);
	const emit = async (name: string) => {
		await hooks.get(name)?.({}, ctx);
	};
	const getTool = (name: string) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(`Tool not registered: ${name}`);
		return tool;
	};
	const control = (params: Record<string, unknown>, signal?: AbortSignal) =>
		getTool("process_control").execute("control", params, signal, undefined, ctx);
	return {
		entries,
		sendMessage,
		emit,
		control,
		setIdle: (value: boolean) => {
			idle = value;
		},
		async start(mode = "wait") {
			const result = await getTool("background_process").execute(
				"start",
				{ command: "example", mode },
				undefined,
				undefined,
				ctx,
			);
			return result.details.id as string;
		},
		async finish(index: number, result: Partial<ProcessResult> = {}) {
			jobs[index].finish({
				status: "complete",
				exitCode: 0,
				output: "done",
				logBytes: 4,
				...result,
			});
			await jobs[index].done;
		},
		async settle() {
			idle = true;
			await emit("agent_settled");
		},
	};
}

beforeEach(() => {
	mocks.root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-process-delivery-"));
	mocks.launch.mockReset();
});
afterEach(() => {
	vi.useRealTimers();
	fs.rmSync(mocks.root, { recursive: true, force: true });
});

describe("background process completion delivery", () => {
	it.each(["wait", "status"])(
		"does not replay a terminal result read through %s after it completed",
		async (action) => {
			const app = harness();
			await app.emit("session_start");
			const id = await app.start();
			await app.finish(0, { status: "failed", exitCode: 1, output: "assertion failed" });
			expect(app.sendMessage).not.toHaveBeenCalled();
			const result = await app.control({ action, id });
			expect(result.details.status).toBe("failed");
			await app.settle();
			expect(app.sendMessage).not.toHaveBeenCalled();
			await app.emit("session_start");
			expect(app.sendMessage).not.toHaveBeenCalled();
		},
	);

	it("consumes a result when wait was already blocked on completion", async () => {
		const app = harness();
		await app.emit("session_start");
		const id = await app.start();
		const waiting = app.control({ action: "wait", id });
		await app.finish(0);
		expect((await waiting).details.timedOut).toBe(false);
		await app.settle();
		expect(app.sendMessage).not.toHaveBeenCalled();
	});

	it("batches only unread outcomes after the parent settles", async () => {
		const app = harness();
		await app.emit("session_start");
		const consumed = await app.start();
		const failure = await app.start();
		const service = await app.start("service");
		await app.finish(0);
		await app.finish(1, { status: "failed", exitCode: 2, output: "missing configuration" });
		await app.finish(2, { status: "stopped", exitCode: null });
		await app.control({ action: "wait", id: consumed });
		expect(app.sendMessage).not.toHaveBeenCalled();
		await app.settle();
		expect(app.sendMessage).toHaveBeenCalledTimes(1);
		const [notification] = app.sendMessage.mock.calls[0];
		expect(notification.details.ids).toEqual([failure, service]);
		expect(notification.content).toContain("missing configuration");
		expect(notification.content).toContain("status: stopped");
		expect(notification.content).not.toContain(consumed);
		await app.settle();
		await app.emit("session_start");
		expect(app.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("does not consume a running status or a timed-out wait", async () => {
		vi.useFakeTimers();
		const app = harness();
		await app.emit("session_start");
		const id = await app.start();
		await app.control({ action: "status", id });
		const waiting = app.control({ action: "wait", id, timeoutSeconds: 1 });
		await vi.advanceTimersByTimeAsync(1000);
		expect((await waiting).details.timedOut).toBe(true);
		await app.finish(0, { status: "timed_out", exitCode: null });
		await app.settle();
		expect(app.sendMessage.mock.calls[0][0].details.ids).toEqual([id]);
	});

	it("does not consume an aborted wait", async () => {
		const app = harness();
		await app.emit("session_start");
		const id = await app.start();
		const abort = new AbortController();
		const waiting = app.control({ action: "wait", id }, abort.signal);
		const rejected = expect(waiting).rejects.toThrow();
		abort.abort();
		await rejected;
		await app.finish(0);
		await app.settle();
		expect(app.sendMessage.mock.calls[0][0].details.ids).toEqual([id]);
	});

	it("does not acknowledge an already completed result when wait was cancelled before invocation", async () => {
		const app = harness();
		await app.emit("session_start");
		const id = await app.start();
		await app.finish(0);
		const abort = new AbortController();
		abort.abort();
		await expect(app.control({ action: "wait", id }, abort.signal)).rejects.toThrow("aborted");
		await app.settle();
		expect(app.sendMessage.mock.calls[0][0].details.ids).toEqual([id]);
	});

	it("keeps completion unread when cancellation races with the wait result", async () => {
		const app = harness();
		await app.emit("session_start");
		const id = await app.start();
		const abort = new AbortController();
		const waiting = app.control({ action: "wait", id }, abort.signal);
		const rejected = expect(waiting).rejects.toThrow("aborted");
		const finished = app.finish(0);
		queueMicrotask(() => abort.abort());
		await finished;
		await rejected;
		await app.settle();
		expect(app.sendMessage.mock.calls[0][0].details.ids).toEqual([id]);
	});

	it("listing statuses does not silently consume all results", async () => {
		const app = harness();
		await app.emit("session_start");
		const id = await app.start();
		await app.finish(0);
		await app.control({ action: "status" });
		await app.settle();
		expect(app.sendMessage.mock.calls[0][0].details.ids).toEqual([id]);
	});

	it("queues at most one notification while the SDK still reports idle", async () => {
		const app = harness();
		await app.emit("session_start");
		await app.start();
		const second = await app.start();
		app.setIdle(true);
		await app.finish(0);
		await app.finish(1);
		expect(app.sendMessage).toHaveBeenCalledTimes(1);
		await app.settle();
		expect(app.sendMessage).toHaveBeenCalledTimes(2);
		expect(app.sendMessage.mock.calls[1][0].details.ids).toEqual([second]);
	});

	it("bounds batches without acknowledging results that did not fit", async () => {
		const app = harness();
		await app.emit("session_start");
		const ids: string[] = [];
		for (let index = 0; index < 12; index++) {
			ids.push(await app.start());
			await app.finish(index, { output: `${"界".repeat(40)}\n`.repeat(100) });
		}
		await app.settle();
		const first = app.sendMessage.mock.calls[0][0];
		expect(Buffer.byteLength(first.content)).toBeLessThanOrEqual(4096);
		expect(first.details.ids.length).toBeLessThan(ids.length);
		await app.settle();
		const second = app.sendMessage.mock.calls[1][0];
		expect(Buffer.byteLength(second.content)).toBeLessThanOrEqual(4096);
		expect([...first.details.ids, ...second.details.ids]).toEqual(ids);
	});

	it("retains failed deliveries for retry", async () => {
		const app = harness();
		await app.emit("session_start");
		const id = await app.start();
		await app.finish(0);
		app.sendMessage.mockImplementationOnce(() => {
			throw new Error("transport unavailable");
		});
		await app.settle();
		await app.settle();
		expect(app.sendMessage).toHaveBeenCalledTimes(2);
		expect(app.sendMessage.mock.calls[1][0].details.ids).toEqual([id]);
		await app.settle();
		expect(app.sendMessage).toHaveBeenCalledTimes(2);
	});

	it.each(["single", "batch"])("recognizes persisted %s receipts without replaying them", async (kind) => {
		const app = harness();
		await app.emit("session_start");
		const id = await app.start();
		await app.finish(0);
		app.entries.push({
			type: "custom_message",
			customType: "pi-core-background-process-result",
			details: kind === "single" ? { id } : { ids: [id] },
		});
		await app.emit("session_start");
		await app.settle();
		expect(app.sendMessage).not.toHaveBeenCalled();
	});

	it("recovers an unread completion after reload", async () => {
		const app = harness();
		await app.emit("session_start");
		const id = await app.start();
		await app.finish(0, { status: "failed", exitCode: 1 });
		await app.emit("session_start");
		expect(app.sendMessage).not.toHaveBeenCalled();
		await app.settle();
		expect(app.sendMessage.mock.calls[0][0].details.ids).toEqual([id]);
		await app.settle();
		expect(app.sendMessage).toHaveBeenCalledTimes(1);
	});

	it("ignores old completions after a branch change", async () => {
		const app = harness();
		await app.emit("session_start");
		await app.start();
		app.entries.length = 0;
		await app.emit("session_start");
		await app.finish(0);
		await app.settle();
		expect(app.sendMessage).not.toHaveBeenCalled();
	});
});
