import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { expect, it, vi } from "vitest";
import backgroundProcesses from "../extensions/background-process/index.js";
import type { ProcessResult, runBackgroundProcess } from "../extensions/background-process/process.js";
import schedulerExtension from "../extensions/scheduler/index.js";

const mocks = vi.hoisted(() => ({ root: "", launch: vi.fn<typeof runBackgroundProcess>() }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => mocks.root,
}));
vi.mock("../extensions/background-process/process.js", async (original) => ({
	...(await original<typeof import("../extensions/background-process/process.js")>()),
	runBackgroundProcess: mocks.launch,
}));
interface Tool {
	name: string;
	execute(
		id: string,
		args: unknown,
		signal: undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: { text: string }[] }>;
}
it("scheduler shells do not block background completion and cancellation stays isolated", async () => {
	mocks.root = mkdtempSync(join(tmpdir(), "scheduler-coexist-"));
	const hooks = new Map<string, ((event: unknown, ctx: ExtensionContext) => unknown)[]>();
	const tools = new Map<string, Tool>();
	const entries: unknown[] = [];
	let idle = true;
	const jobs = new Map<string, { stop: ReturnType<typeof vi.fn>; finish(result: ProcessResult): void }>();
	mocks.launch.mockImplementation(
		(options) =>
			new Promise((resolve) => {
				const stop = vi.fn();
				options.onSpawn({ stop });
				jobs.set(options.command, {
					stop,
					finish: (result) => {
						options.log.close();
						resolve(result);
					},
				});
			}),
	);
	const sendMessage = vi.fn((message: { customType: string; details: unknown }) => {
		entries.push({ type: "custom_message", ...message });
		idle = false;
	});
	const ctx = {
		cwd: mocks.root,
		isIdle: () => idle,
		ui: { notify: vi.fn(), setStatus: vi.fn() },
		sessionManager: { getSessionId: () => "coexist", getBranch: () => entries },
	} as unknown as ExtensionContext;
	const pi = {
		on: (name: string, hook: (event: unknown, ctx: ExtensionContext) => unknown) =>
			hooks.set(name, [...(hooks.get(name) ?? []), hook]),
		registerTool: (tool: Tool) => tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage,
	} as unknown as ExtensionAPI;
	backgroundProcesses(pi);
	schedulerExtension(pi);
	const emit = async (name: string) => {
		for (const hook of hooks.get(name) ?? []) await hook({}, ctx);
	};
	const call = async (name: string, args: unknown) => {
		const tool = tools.get(name);
		if (!tool) throw new Error(name);
		return tool.execute("test", args, undefined, undefined, ctx);
	};
	const now = Date.now();
	const clock = vi.spyOn(Date, "now").mockReturnValue(now);
	try {
		await emit("session_start");
		const created = await call("schedule", {
			action: "create",
			job: { when: "+30s", command: "scheduled-check", prompt: "check" },
		});
		const id = JSON.parse(created.content[0].text).id;
		await call("background_process", { command: "independent-check", mode: "wait" });
		clock.mockReturnValue(now + 30001);
		await emit("agent_settled"); // Must return without awaiting scheduled-check.
		expect(jobs.size).toBe(2);
		jobs
			.get("independent-check")
			?.finish({ status: "complete", exitCode: 0, output: "background done", logBytes: 0 });
		await vi.waitFor(() => expect(sendMessage).toHaveBeenCalledTimes(1));
		expect(sendMessage.mock.calls[0][0].customType).not.toBe("pi-core-schedule");
		await call("schedule", { action: "pause", id });
		expect(jobs.get("scheduled-check")?.stop).toHaveBeenCalledTimes(1);
		expect(jobs.get("independent-check")?.stop).not.toHaveBeenCalled();
		jobs
			.get("scheduled-check")
			?.finish({ status: "stopped", exitCode: null, output: "stopped", logBytes: 0 });
		idle = true;
		await emit("agent_settled");
		expect(sendMessage).toHaveBeenCalledTimes(1);
	} finally {
		await emit("session_shutdown");
		vi.restoreAllMocks();
		rmSync(mocks.root, { recursive: true, force: true });
	}
});
