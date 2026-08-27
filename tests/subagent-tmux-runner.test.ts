import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentConfig } from "../extensions/subagent/agents.js";
import {
	listPendingCommands,
	openSidecarChannel,
	publishQuestion,
	publishResult,
} from "../extensions/subagent/channel.js";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.js";
import { createChildLineage } from "../extensions/subagent/protocol.js";
import {
	type ChildHandle,
	createTmuxTuiRunner,
	type RunAgentOptions,
	RunnerDetachedError,
	RunnerRouter,
} from "../extensions/subagent/runner.js";
import { TmuxClient, TmuxLaunchError } from "../extensions/subagent/tmux.js";

const roots: string[] = [];

afterEach(() => {
	for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
	const root = fs.mkdtempSync(path.join(os.tmpdir(), "pi-core-tmux-runner-test-"));
	roots.push(root);
	return root;
}

function agent(): AgentConfig {
	return {
		name: "worker",
		description: "worker",
		tools: ["read"],
		children: ["reviewer"],
		systemPrompt: "Work carefully.",
		source: "bundled",
		filePath: "/agent.md",
	};
}

function options(root: string, callbacks: Partial<RunAgentOptions> = {}): RunAgentOptions {
	const parentSession = path.join(root, "parent.jsonl");
	fs.writeFileSync(parentSession, '{"type":"session","version":3,"id":"parent","cwd":"/repo"}\n');
	const lineage = createChildLineage({
		parent: null,
		runId: "abcd1234",
		agent: "worker",
		allowedChildren: ["reviewer"],
		limits: { ...DEFAULT_SUBAGENT_LIMITS },
		registryPath: path.join(root, "concurrency.json"),
	});
	return {
		agent: agent(),
		task: "Inspect the implementation.",
		cwd: root,
		ctx: {
			model: null,
			thinkingLevel: "low",
			sessionManager: { getSessionFile: () => parentSession },
		} as unknown as ExtensionContext,
		lineage,
		limits: { ...DEFAULT_SUBAGENT_LIMITS },
		onSpawn() {},
		onQuestion() {},
		onStatus() {},
		...callbacks,
	};
}

function fakeTmux(calls: string[][]): TmuxClient {
	return new TmuxClient({ TMUX: "/tmp/tmux", TMUX_PANE: "%5" }, (_command, args) => {
		calls.push(args);
		if (args[0] === "display-message") return args.at(-1) === "#{pane_dead}" ? "0\n" : "%5\n";
		if (args[0] === "split-window") return "%9\n";
		return "";
	});
}

async function launchRunner(root: string): Promise<{
	runner: ReturnType<typeof createTmuxTuiRunner>;
	handle: ChildHandle;
	run: Promise<string>;
	options: RunAgentOptions;
	calls: string[][];
}> {
	const calls: string[][] = [];
	const runner = createTmuxTuiRunner(fakeTmux(calls), path.join(root, "runs"), path.join(root, "sessions"));
	let spawned!: (handle: ChildHandle) => void;
	const handleReady = new Promise<ChildHandle>((resolve) => {
		spawned = resolve;
	});
	const runOptions = options(root, { onSpawn: spawned });
	const run = runner.run(runOptions);
	const handle = await handleReady;
	return { runner, handle, run, options: runOptions, calls };
}

describe("TmuxTuiRunner", () => {
	it("creates a real TUI pane loadout and a persistent parent-linked child session", async () => {
		const root = temporaryRoot();
		const { handle, run, calls, options: runOptions } = await launchRunner(root);
		expect(handle.runtime.backend).toBe("tmux-tui");
		if (handle.runtime.backend !== "tmux-tui") throw new Error("expected tmux runtime");

		const header = JSON.parse(fs.readFileSync(handle.runtime.sessionFile, "utf8").split("\n")[0]);
		expect(header.parentSession).toBe(runOptions.ctx.sessionManager.getSessionFile());
		const split = calls.find((args) => args[0] === "split-window") ?? [];
		expect(split.some((arg) => arg.startsWith("PI_CORE_SUBAGENT_CONTEXT="))).toBe(true);
		const joined = split.join("\n");
		expect(joined).toContain("PI_CORE_SUBAGENT_CHANNEL=");
		expect(joined).toContain("--no-extensions");
		expect(joined).toContain(path.resolve("extensions/subagent/index.ts"));
		expect(joined).toContain("--no-skills");
		expect(joined).toContain("--no-prompt-templates");
		expect(joined).toContain("--session");
		expect(joined).toContain("read,ask_parent,background_agent,agent_control");
		expect(joined).toContain(`@${path.join(handle.runtime.channelDirectory, "task.md")}`);
		expect(joined).not.toContain("--mode\nrpc");

		const channel = openSidecarChannel({
			directory: handle.runtime.channelDirectory,
			token: handle.runtime.channelToken,
			lineage: runOptions.lineage,
		});
		publishResult(channel, { status: "complete", output: "bounded handoff", finishedAt: Date.now() });
		await expect(run).resolves.toBe("bounded handoff");
	});

	it("delivers ask/reply and steering through sidecar commands, never pane keystrokes", async () => {
		const root = temporaryRoot();
		let questionSeen!: (id: string) => void;
		const questionReady = new Promise<string>((resolve) => {
			questionSeen = resolve;
		});
		const launched = await launchRunner(root);
		launched.options.onQuestion = (question) => questionSeen(question.id);
		// Reattach with the callback because the launch options were already captured by the runner.
		launched.handle.detach();
		await expect(launched.run).rejects.toBeInstanceOf(RunnerDetachedError);
		if (launched.handle.runtime.backend !== "tmux-tui") throw new Error("expected tmux runtime");
		const attached = launched.runner.attach(launched.options, launched.handle.runtime);
		const channel = openSidecarChannel({
			directory: launched.handle.runtime.channelDirectory,
			token: launched.handle.runtime.channelToken,
			lineage: launched.options.lineage,
		});
		publishQuestion(channel, { id: "question1", text: "Which API?", askedAt: Date.now() });
		expect(await questionReady).toBe("question1");
		launched.handle.reply("question1", "Use API A");
		launched.handle.message("Also inspect errors");
		expect(listPendingCommands(channel)).toMatchObject([
			{ type: "reply", questionId: "question1", text: "Use API A" },
			{ type: "message", text: "Also inspect errors" },
		]);
		publishResult(channel, { status: "complete", output: "done", finishedAt: Date.now() });
		await expect(attached).resolves.toBe("done");
		expect(launched.calls.some((args) => args[0] === "send-keys")).toBe(false);
	});

	it("reattaches after reload and sends cancellation through the private channel", async () => {
		const root = temporaryRoot();
		const launched = await launchRunner(root);
		launched.handle.detach();
		await expect(launched.run).rejects.toBeInstanceOf(RunnerDetachedError);
		if (launched.handle.runtime.backend !== "tmux-tui") throw new Error("expected tmux runtime");
		let attachedHandle!: ChildHandle;
		const attachedOptions = {
			...launched.options,
			onSpawn: (handle: ChildHandle) => (attachedHandle = handle),
		};
		const attached = launched.runner.attach(attachedOptions, launched.handle.runtime);
		attachedHandle.abort();
		const channel = openSidecarChannel({
			directory: launched.handle.runtime.channelDirectory,
			token: launched.handle.runtime.channelToken,
			lineage: launched.options.lineage,
		});
		expect(listPendingCommands(channel)).toMatchObject([{ type: "cancel" }]);
		publishResult(channel, { status: "stopped", output: "stopped", finishedAt: Date.now() });
		await expect(attached).rejects.toThrow("stopped");
	});
});

describe("RunnerRouter backend selection", () => {
	class StubRpc {
		calls = 0;
		async run(): Promise<string> {
			this.calls++;
			return "rpc";
		}
	}

	class StubTmux {
		calls = 0;
		constructor(
			private readonly enabled: boolean,
			private readonly launchFailure = false,
		) {}
		available(): boolean {
			return this.enabled;
		}
		async run(): Promise<string> {
			this.calls++;
			if (this.launchFailure) throw new TmuxLaunchError("launch failed");
			return "tmux";
		}
		async attach(): Promise<string> {
			return "attached";
		}
	}

	it("uses RPC outside tmux without touching the tmux runner", async () => {
		const root = temporaryRoot();
		const rpc = new StubRpc();
		const tmux = new StubTmux(false);
		await expect(new RunnerRouter(rpc, tmux).run(options(root))).resolves.toBe("rpc");
		expect(rpc.calls).toBe(1);
		expect(tmux.calls).toBe(0);
	});

	it("falls back to RPC only when tmux launch fails before work starts", async () => {
		const root = temporaryRoot();
		const rpc = new StubRpc();
		const tmux = new StubTmux(true, true);
		await expect(new RunnerRouter(rpc, tmux).run(options(root))).resolves.toBe("rpc");
		expect(tmux.calls).toBe(1);
		expect(rpc.calls).toBe(1);
	});
});
