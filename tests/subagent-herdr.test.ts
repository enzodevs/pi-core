import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	acknowledgeCommand,
	listPendingCommands,
	openSidecarChannel,
	publishQuestion,
	publishReady,
	publishResult,
} from "../extensions/subagent/channel.ts";
import { HerdrClient, HerdrLaunchError } from "../extensions/subagent/herdr.ts";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.ts";
import { createChildLineage } from "../extensions/subagent/protocol.ts";
import {
	type ChildHandle,
	createHerdrTuiRunner,
	type RunAgentOptions,
	RunnerDetachedError,
	RunnerRouter,
} from "../extensions/subagent/runner.ts";

const roots: string[] = [];
afterEach(() => {
	vi.useRealTimers();
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function setup(uncertainAdmission = false) {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-herdr-test-"));
	roots.push(root);
	const calls: Array<{ args: string[]; env: NodeJS.ProcessEnv }> = [];
	let tab = 0;
	const client = new HerdrClient(
		{ HERDR_ENV: "1", HERDR_SOCKET_PATH: "/test/herdr.sock", HERDR_PANE_ID: "w1:p1" },
		(_command, args, env) => {
			calls.push({ args, env });
			if (args[0] === "pane" && args[1] === "run") {
				if (uncertainAdmission) throw new Error("admitted but response lost");
				return "";
			}
			if (args[1] === "create") {
				tab++;
				return JSON.stringify({
					result: {
						...(args[0] === "workspace" ? { workspace: { workspace_id: "w2" } } : {}),
						tab: { tab_id: `w2:t${tab}`, workspace_id: "w2" },
						root_pane: { pane_id: `w2:p${tab}` },
					},
				});
			}
			if (args[0] === "pane" && args[1] === "get")
				return JSON.stringify({ result: { pane: { pane_id: args[2] } } });
			return JSON.stringify({ result: {} });
		},
	);
	const lineage = createChildLineage({
		parent: null,
		runId: "abcd1234",
		agent: "worker",
		allowedChildren: [],
		limits: DEFAULT_SUBAGENT_LIMITS,
		registryPath: path.join(root, "registry.json"),
	});
	const options: RunAgentOptions = {
		agent: {
			name: "worker",
			description: "worker",
			systemPrompt: "work",
			source: "bundled",
			filePath: "/worker.md",
		},
		task: "Inspect only",
		cwd: root,
		lineage,
		limits: DEFAULT_SUBAGENT_LIMITS,
		ctx: {
			model: null,
			sessionManager: { getSessionFile: () => path.join(root, "parent.jsonl") },
		} as unknown as ExtensionContext,
		onSpawn() {},
		onQuestion() {},
		onStatus() {},
	};
	return { root, client, calls, options };
}

describe("Herdr terminal backend", () => {
	it("groups child tabs away from the parent and never types task text or tokens into terminal input", async () => {
		const { root, client, calls, options } = setup();
		const runner = createHerdrTuiRunner(client, path.join(root, "runs"), path.join(root, "sessions"));
		for (let index = 0; index < 2; index++) {
			let handle!: ChildHandle;
			let ready!: () => void;
			const spawned = new Promise<void>((resolve) => {
				ready = resolve;
			});
			const run = runner.run({
				...options,
				onSpawn(child) {
					handle = child;
					ready();
				},
			});
			await spawned;
			if (handle.runtime.backend !== "herdr-tui") throw new Error("Expected Herdr runtime");
			const channel = openSidecarChannel({
				directory: handle.runtime.channelDirectory,
				token: handle.runtime.channelToken,
				lineage: options.lineage,
			});
			publishReady(channel);
			expect(handle.runtime.location.socketPath).toBe("/test/herdr.sock");
			const launch =
				calls
					.filter(({ args }) => args[1] === "run")
					.at(-1)
					?.args.at(-1) ?? "";
			expect(launch).toContain("launch.sh");
			expect(launch).not.toContain(channel.token);
			expect(launch).not.toContain(options.task);
			const script = fs.readFileSync(path.join(channel.directory, "launch.sh"), "utf8");
			expect(script).toContain("PI_CORE_SUBAGENT_CONTEXT=");
			expect(script).toContain("PI_CORE_SUBAGENT_HERDR=1");
			expect(script).not.toContain("--no-extensions");
			expect(script).not.toContain("--no-approve");
			publishResult(channel, { status: "complete", output: "done", finishedAt: Date.now() });
			await expect(run).resolves.toBe("done");
		}
		expect(calls.filter(({ args }) => args[0] === "workspace" && args[1] === "create")).toHaveLength(1);
		expect(calls.filter(({ args }) => args[0] === "tab" && args[1] === "create")).toHaveLength(1);
		for (const { args } of calls.filter(({ args }) => args[1] === "create"))
			expect(args).toContain("--no-focus");
		expect(calls.some(({ args }) => args[1] === "split")).toBe(false);
	});

	it("shares one workspace across concurrent sibling launches", async () => {
		const { root, client, calls } = setup();
		const launches = [0, 1, 2].map((index) => {
			const directory = path.join(root, String(index));
			fs.mkdirSync(directory);
			return client.launch(
				{
					cwd: root,
					title: `worker:${index}`,
					channelDirectory: directory,
					channelToken: "fixture",
					environment: {},
					command: "node",
					args: [],
				},
				"/parent.jsonl",
			);
		});
		const locations = await Promise.all(launches);
		expect(new Set(locations.map((location) => location.paneId)).size).toBe(3);
		expect(calls.filter(({ args }) => args[0] === "workspace" && args[1] === "create")).toHaveLength(1);
		expect(calls.filter(({ args }) => args[0] === "tab" && args[1] === "create")).toHaveLength(2);
	});

	it("reattaches questions after reload and confirms replies through receipts, not keystrokes", async () => {
		const { root, client, options } = setup();
		const runner = createHerdrTuiRunner(client, path.join(root, "runs"), path.join(root, "sessions"));
		let handle!: ChildHandle;
		let ready!: () => void;
		const spawned = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const run = runner.run({
			...options,
			onSpawn(child) {
				handle = child;
				ready();
			},
		});
		await spawned;
		if (handle.runtime.backend !== "herdr-tui") throw new Error("Expected Herdr runtime");
		const channel = openSidecarChannel({
			directory: handle.runtime.channelDirectory,
			token: handle.runtime.channelToken,
			lineage: options.lineage,
		});
		publishReady(channel);
		handle.detach();
		await expect(run).rejects.toBeInstanceOf(RunnerDetachedError);
		publishQuestion(channel, { id: "question1", text: "Which API?", askedAt: Date.now() });
		const onQuestion = vi.fn();
		const attached = runner.attach(
			{
				...options,
				onQuestion,
				onSpawn(child) {
					handle = child;
				},
			},
			handle.runtime,
		);
		expect(onQuestion).toHaveBeenCalledWith(expect.objectContaining({ id: "question1" }));
		let accepted = false;
		const reply = Promise.resolve(handle.reply("question1", "Use A")).then(() => {
			accepted = true;
		});
		expect(accepted).toBe(false);
		const command = listPendingCommands(channel)[0];
		if (!command) throw new Error("Missing command");
		acknowledgeCommand(channel, command.id);
		await reply;
		expect(accepted).toBe(true);
		publishResult(channel, { status: "complete", output: "continued", finishedAt: Date.now() });
		await expect(attached).resolves.toBe("continued");
	});

	it("keeps moved Herdr children alive through their private heartbeat", async () => {
		vi.useFakeTimers();
		const { root, client, options } = setup();
		vi.spyOn(client, "alive").mockResolvedValue(false); // Old pane ID disappeared after a move.
		const runner = createHerdrTuiRunner(client, path.join(root, "runs"), path.join(root, "sessions"));
		let handle!: ChildHandle;
		let ready!: () => void;
		const spawned = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const run = runner.run({
			...options,
			onSpawn(child) {
				handle = child;
				ready();
			},
		});
		await spawned;
		if (handle.runtime.backend !== "herdr-tui") throw new Error("Expected Herdr runtime");
		const channel = openSidecarChannel({
			directory: handle.runtime.channelDirectory,
			token: handle.runtime.channelToken,
			lineage: options.lineage,
		});
		publishReady(channel);
		for (let index = 0; index < 8; index++) {
			await vi.advanceTimersByTimeAsync(1_000);
			publishReady(channel);
		}
		publishResult(channel, { status: "complete", output: "moved but supervised", finishedAt: Date.now() });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(run).resolves.toBe("moved but supervised");
	});

	it("retains supervision when pane admission succeeds but its response is lost", async () => {
		const { root, client, calls, options } = setup(true);
		const runner = createHerdrTuiRunner(client, path.join(root, "runs"), path.join(root, "sessions"));
		let handle!: ChildHandle;
		let ready!: () => void;
		const spawned = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const run = runner.run({
			...options,
			onSpawn(child) {
				handle = child;
				ready();
			},
		});
		await spawned;
		if (handle.runtime.backend !== "herdr-tui") throw new Error("Expected Herdr runtime");
		const channel = openSidecarChannel({
			directory: handle.runtime.channelDirectory,
			token: handle.runtime.channelToken,
			lineage: options.lineage,
		});
		publishReady(channel);
		publishResult(channel, { status: "complete", output: "supervised", finishedAt: Date.now() });
		await expect(run).resolves.toBe("supervised");
		expect(calls.filter(({ args }) => args[1] === "run")).toHaveLength(1);
	});

	it("keeps liveness asynchronous and non-overlapping while sidecar receipts continue", async () => {
		vi.useFakeTimers();
		const { root, client, options } = setup();
		let release!: (value: boolean) => void;
		const alive = vi.spyOn(client, "alive").mockReturnValue(
			new Promise((resolve) => {
				release = resolve;
			}),
		);
		const runner = createHerdrTuiRunner(client, path.join(root, "runs"), path.join(root, "sessions"));
		let handle!: ChildHandle;
		let ready!: () => void;
		const spawned = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const run = runner.run({
			...options,
			onSpawn(child) {
				handle = child;
				ready();
			},
		});
		await spawned;
		if (handle.runtime.backend !== "herdr-tui") throw new Error("Expected Herdr runtime");
		const channel = openSidecarChannel({
			directory: handle.runtime.channelDirectory,
			token: handle.runtime.channelToken,
			lineage: options.lineage,
		});
		publishReady(channel);
		await vi.advanceTimersByTimeAsync(5_000);
		expect(alive).toHaveBeenCalledTimes(1);
		const reply = Promise.resolve(handle.reply("q1", "answer"));
		const command = listPendingCommands(channel)[0];
		if (!command) throw new Error("Missing reply command");
		acknowledgeCommand(channel, command.id);
		await vi.advanceTimersByTimeAsync(250);
		await reply;
		publishResult(channel, { status: "complete", output: "done", finishedAt: Date.now() });
		await vi.advanceTimersByTimeAsync(1_000);
		await expect(run).resolves.toBe("done");
		release(false);
		await Promise.resolve();
	});

	it("bounds unacknowledged startup and leaves cancellation durable for late startup", async () => {
		vi.useFakeTimers();
		const { root, client, options } = setup();
		const runner = createHerdrTuiRunner(client, path.join(root, "runs"), path.join(root, "sessions"));
		let handle!: ChildHandle;
		let ready!: () => void;
		const spawned = new Promise<void>((resolve) => {
			ready = resolve;
		});
		const run = runner.run({
			...options,
			onSpawn(child) {
				handle = child;
				ready();
			},
		});
		const failed = expect(run).rejects.toThrow("acknowledge startup");
		await spawned;
		await vi.advanceTimersByTimeAsync(30_000);
		await failed;
		if (handle.runtime.backend !== "herdr-tui") throw new Error("Expected Herdr runtime");
		const channel = openSidecarChannel({
			directory: handle.runtime.channelDirectory,
			token: handle.runtime.channelToken,
			lineage: options.lineage,
		});
		expect(listPendingCommands(channel)).toMatchObject([{ type: "cancel" }]);
		expect(fs.existsSync(channel.directory)).toBe(true);
	});

	it("pins the server endpoint and treats transport failure as unknown liveness", async () => {
		const { client, calls } = setup();
		const location = { paneId: "w2:p1", tabId: "w2:t1", workspaceId: "w2", socketPath: "/other.sock" };
		await expect(client.alive(location)).resolves.toBe(true);
		expect(calls.some(({ args }) => args[1] === "close")).toBe(false);
		expect(calls[0]?.env.HERDR_SOCKET_PATH).toBe("/other.sock");
		const offline = new HerdrClient({}, () => {
			throw new Error("offline");
		});
		await expect(offline.alive(location)).resolves.toBeUndefined();
		const closed = new HerdrClient({}, () => {
			throw Object.assign(new Error("closed"), {
				stderr: JSON.stringify({ error: { code: "pane_not_found" } }),
			});
		});
		await expect(closed.alive(location)).resolves.toBe(false);
	});

	it("prefers Herdr over outer tmux and never retries an ambiguous launch through RPC", async () => {
		const { options } = setup();
		const rpc = { run: vi.fn(async () => "rpc") };
		const tmux = { available: () => true, run: vi.fn(async () => "tmux"), attach: vi.fn(async () => "tmux") };
		const herdr = {
			available: () => true,
			run: vi.fn(async () => "herdr"),
			attach: vi.fn(async () => "herdr"),
		};
		const router = new RunnerRouter(rpc, tmux, herdr);
		await expect(router.run(options)).resolves.toBe("herdr");
		herdr.run.mockRejectedValueOnce(new HerdrLaunchError("unconfirmed"));
		await expect(router.run(options)).rejects.toThrow("unconfirmed");
		expect(rpc.run).not.toHaveBeenCalled();
		expect(tmux.run).not.toHaveBeenCalled();
	});
});
