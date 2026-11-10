import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionToolContext } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createManagedBashDefinition } from "../extensions/background-process/foreground.js";
import backgroundProcesses from "../extensions/background-process/index.js";
import { ProcessLog } from "../extensions/background-process/log-store.js";

const state = vi.hoisted(() => ({ root: "" }));
vi.mock("@earendil-works/pi-coding-agent", async (original) => ({
	...(await original<typeof import("@earendil-works/pi-coding-agent")>()),
	getAgentDir: () => state.root,
}));

type BashDefinition = ReturnType<typeof createManagedBashDefinition>;
type BashResult = Awaited<ReturnType<BashDefinition["execute"]>>;
interface Entry {
	type: string;
	customType?: string;
	data?: unknown;
	details?: { ids: string[] };
}
interface Notification {
	customType: string;
	content: string;
	details: { ids: string[] };
}
interface ControlTool {
	name: string;
	execute(
		id: string,
		params: Record<string, unknown>,
		signal: undefined,
		update: undefined,
		ctx: ExtensionContext,
	): Promise<{ content: { text: string }[]; details: { status?: string } }>;
}

function harness() {
	const emitter = new EventEmitter();
	const hooks = new Map<string, (event: unknown, ctx: ExtensionContext) => unknown>();
	const tools = new Map<string, ControlTool>();
	const entries: Entry[] = [];
	let idle = false;
	const sendMessage = vi.fn((message: Notification) => {
		entries.push({ type: "custom_message", ...message });
	});
	const pi = {
		events: {
			on: (name: string, fn: (data: unknown) => void) => {
				emitter.on(name, fn);
				return () => emitter.off(name, fn);
			},
			emit: (name: string, data: unknown) => {
				emitter.emit(name, data);
			},
		},
		on: (name: string, fn: (event: unknown, ctx: ExtensionContext) => unknown) => hooks.set(name, fn),
		registerTool: (tool: ControlTool) => tools.set(tool.name, tool),
		registerCommand: vi.fn(),
		appendEntry: (customType: string, data: unknown) => entries.push({ type: "custom", customType, data }),
		sendMessage,
	} as unknown as ExtensionAPI;
	const ctx = {
		cwd: state.root,
		mode: "tui",
		isIdle: () => idle,
		ui: { setStatus: vi.fn(), notify: vi.fn() },
		sessionManager: {
			getSessionId: () => "foreground-test",
			getSessionFile: () => undefined,
			getBranch: () => entries,
		},
	} as unknown as ExtensionToolContext;
	backgroundProcesses(pi);
	const emit = (name: string) => hooks.get(name)?.({}, ctx);
	emit("session_start");
	return {
		ctx,
		pi,
		entries,
		sendMessage,
		emit,
		bash: (
			command: string,
			options: {
				delay?: number;
				timeout?: number;
				signal?: AbortSignal;
				update?: Parameters<BashDefinition["execute"]>[3];
			} = {},
		) =>
			createManagedBashDefinition(state.root, pi, options.delay ?? 10).execute(
				"bash",
				{ command, timeout: options.timeout },
				options.signal,
				options.update,
				ctx,
			),
		control: (action: string, id?: string, query?: string) => {
			const tool = tools.get("process_control");
			if (!tool) throw new Error("process_control missing");
			return tool.execute("control", { action, id, query, timeoutSeconds: 5 }, undefined, undefined, ctx);
		},
		settle: () => {
			idle = true;
			emit("agent_settled");
		},
	};
}

const instances: ReturnType<typeof harness>[] = [];
function setup() {
	const app = harness();
	instances.push(app);
	return app;
}
function slow(code = "console.log('DONE')", ms = 150) {
	return `${JSON.stringify(process.execPath)} -e ${JSON.stringify(`console.log('START');setTimeout(()=>{${code}},${ms})`)}`;
}
function pending(result: BashResult): string {
	const output = result.structuredContent as { status: string; process_id: string };
	expect(output.status).toBe("running");
	expect(output).not.toHaveProperty("exit_code");
	return output.process_id;
}

beforeEach(() => {
	state.root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-foreground-"));
});
afterEach(() => {
	vi.restoreAllMocks();
	for (const app of instances.splice(0)) app.emit("session_shutdown");
	fs.rmSync(state.root, { recursive: true, force: true });
});

describe("foreground bash handoff", () => {
	it("keeps fast output, exit status and no completion notification or retained run", async () => {
		const app = setup();
		const result = await app.bash("printf fast; exit 7", { delay: 1000 });
		expect(result).toHaveProperty("isError", true);
		expect(result.structuredContent).toMatchObject({ output: "fast", exit_code: 7 });
		app.settle();
		expect(app.sendMessage).not.toHaveBeenCalled();
		expect(app.entries).toEqual([]);
		expect((await app.control("status")).content[0].text).toBe("0 processes");
	});

	it("runs once, retains logs, stops tool updates and notifies while the agent is busy", async () => {
		const app = setup();
		const update = vi.fn();
		const marker = path.join(state.root, "executions");
		const id = pending(await app.bash(`printf x >> ${JSON.stringify(marker)}; ${slow()}`, { update }));
		const updateCount = update.mock.calls.length;
		// A completion event, not polling or a fixed delay, drives the assertion.
		const notification = new Promise<void>((resolve) =>
			app.sendMessage.mockImplementationOnce((message) => {
				app.entries.push({ type: "custom_message", ...message });
				resolve();
			}),
		);
		await notification;
		expect(app.ctx.isIdle()).toBe(false);
		expect(update.mock.calls.length).toBe(updateCount);
		expect(fs.readFileSync(marker, "utf8")).toBe("x");
		expect((await app.control("search", id, "DONE")).content[0].text).toContain("DONE");
		app.settle();
		expect(app.sendMessage).toHaveBeenCalledTimes(1);
	});

	it.each(["print", "json", "rpc"] as const)("never yields a pending result in %s mode", async (mode) => {
		const app = setup();
		app.ctx.mode = mode;
		const result = await app.bash(slow());
		expect(result.structuredContent).toMatchObject({ exit_code: 0 });
		expect(app.entries).toEqual([]);
	});

	it("preserves the original deadline after handoff", async () => {
		const app = setup();
		const id = pending(await app.bash(slow("console.log('too late')", 5000), { timeout: 0.15 }));
		const result = await app.control("wait", id);
		expect(result.details.status).toBe("timed_out");
		expect(result.content[0].text).toContain("timed out");
		app.settle();
		expect(app.sendMessage).not.toHaveBeenCalled();
	});

	it("preserves Pi's timeout diagnosis when the shell exited but a child holds its pipes", async () => {
		const app = setup();
		const command = `${JSON.stringify(process.execPath)} -e "setInterval(()=>console.log('pipe held'),20)" & exit 7`;
		const id = pending(await app.bash(command, { timeout: 0.3 }));
		const result = await app.control("wait", id);
		expect(result.details.status).toBe("timed_out");
		expect(result.content[0].text).toContain("The shell exited with code 7");
		expect(result.content[0].text).toContain("background processes it started kept writing output");
	});

	it("process_control stops a handed-off command; aborting its finished call does not", async () => {
		const app = setup();
		const controller = new AbortController();
		const id = pending(await app.bash(slow("console.log('too late')", 5000), { signal: controller.signal }));
		controller.abort();
		expect((await app.control("status", id)).details.status).toBe("running");
		await app.control("stop", id);
		expect((await app.control("wait", id)).details.status).toBe("stopped");
	});

	it("uses execution CWD and Pi session environment", async () => {
		const app = setup();
		const dir = path.join(state.root, "nested");
		fs.mkdirSync(dir);
		app.ctx.cwd = dir;
		const result = await app.bash('printf \'%s:%s\' "$PWD" "$PI_SESSION_ID"', { delay: 1000 });
		expect(result.structuredContent).toMatchObject({ output: `${dir}:foreground-test`, exit_code: 0 });
	});

	it("cancels before handoff without a pending result or notification", async () => {
		const app = setup();
		const controller = new AbortController();
		const result = app.bash(slow("console.log('too late')", 5000), {
			delay: 1000,
			signal: controller.signal,
			update: (update) => {
				if (JSON.stringify(update).includes("START")) controller.abort();
			},
		});
		await expect(result).rejects.toThrow("Command aborted");
		app.settle();
		expect(app.sendMessage).not.toHaveBeenCalled();
		expect(app.entries).toEqual([]);
	});

	it("reports log capture errors after handoff rather than false success", async () => {
		const app = setup();
		vi.spyOn(ProcessLog.prototype, "append").mockImplementation(() => {
			throw new Error("fixture log write failure");
		});
		const id = pending(
			await app.bash(`${JSON.stringify(process.execPath)} -e "setTimeout(()=>console.log('late'),100)"`),
		);
		const result = await app.control("wait", id);
		expect(result.details.status).toBe("failed");
		expect(result.content[0].text).toContain("fixture log write failure");
	});

	it("retains nonzero exit codes after handoff", async () => {
		const app = setup();
		const id = pending(await app.bash(slow("process.exit(9)")));
		const result = await app.control("wait", id);
		expect(result.content[0].text).toContain("exit: 9");
		expect(result.details.status).toBe("failed");
	});
});
