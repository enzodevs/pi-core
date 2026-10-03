import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	type AgentSession,
	createAgentSession,
	createCodemodeExtension,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
	type ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import askUserQuestion from "../extensions/ask-user-question/index.js";
import { READ_SCOPE_KEY } from "../extensions/nested-agents/core.js";
import nestedAgents from "../extensions/nested-agents/index.js";
import sessionCwd, { READ_CWD_KEY } from "../extensions/session-cwd/index.js";
import sudo from "../extensions/sudo/index.js";

let directory: string;
let session: AgentSession;
let events: ToolResultEvent[];
let calls = 0;

async function script(code: string) {
	const tool = session.agent.state.tools.find((tool) => tool.name === "codemode");
	if (!tool) throw new Error("codemode not active");
	const id = `script-${++calls}`;
	// Nested calls require an issuing assistant message. Use a local fixture,
	// not a hosted model request, to supply the script.
	session.agent.state.messages = [
		{
			role: "assistant",
			content: [{ type: "toolCall", id, name: "codemode", arguments: { code } }],
			api: "openai-responses",
			provider: "openai",
			model: "local-test-fixture",
			stopReason: "toolUse",
			timestamp: Date.now(),
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
		},
	];
	const result = await tool.execute(id, { code }, new AbortController().signal);
	return result;
}

function text(result: { content: { type: string; text?: string }[] }): string {
	return result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
}

beforeEach(async () => {
	directory = await mkdtemp(join(tmpdir(), "pi-core-codemode-"));
	await mkdir(join(directory, "src"));
	await writeFile(join(directory, "src", "items.json"), JSON.stringify([{ id: 1 }, { id: 2 }]));
	await writeFile(join(directory, "src", "AGENTS.md"), "NESTED_GUIDE_MARKER");
	events = [];
	const settingsManager = SettingsManager.inMemory({ defaultTools: ["+codemode"], codemode: { mode: "on" } });
	settingsManager.setProjectTrusted(true);
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: join(directory, "agent"),
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		extensionFactories: [
			createCodemodeExtension({ mode: "on" }),
			sessionCwd,
			askUserQuestion,
			sudo,
			nestedAgents,
			(pi) => {
				pi.on("tool_result", (event) => {
					events.push(event);
				});
				pi.on("tool_call", (event) => {
					if (event.toolName === "bash" && event.input.command === "blocked-fixture") {
						return { block: true, reason: "fixture permission denied" };
					}
					return undefined;
				});
			},
		],
	});
	await loader.reload();
	({ session } = await createAgentSession({
		cwd: directory,
		agentDir: join(directory, "agent"),
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(directory),
	}));
	await session.bindExtensions({});
	// Exercise the opt-in nested-guide boundary without making a provider request.
	session.extensionRunner.setFlagValue("nested-agents", true);
	await session.extensionRunner.emitBeforeAgentStart("test", undefined, {
		cwd: directory,
		contextFiles: [{ path: join(directory, "AGENTS.md"), content: "STARTUP" }],
	});
});

afterEach(async () => {
	session?.dispose();
	await rm(directory, { recursive: true, force: true });
});

describe("upstream codemode with pi-core tools (local, no provider calls)", () => {
	it("keeps interactive tools direct-only and rejects script access", async () => {
		expect(session.getActiveToolNames()).toEqual(
			expect.arrayContaining(["codemode", "ask_user_question", "sudo"]),
		);
		expect(session.getCallableToolNames()).not.toEqual(expect.arrayContaining(["ask_user_question"]));
		expect(session.getCallableToolNames()).not.toEqual(expect.arrayContaining(["sudo"]));
		const result = await script(
			'return { ask: "ask_user_question" in tools, sudo: "sudo" in tools, recursive: "codemode" in tools };',
		);
		expect(text(result)).toContain('"ask":false');
		expect(text(result)).toContain('"sudo":false');
		expect(text(result)).toContain('"recursive":false');
		const rejected = await script('await tools.ask_user_question({ question: "Should not reach UI" });');
		expect(rejected.isError).toBe(true);
	});

	it("batches and filters structured bash results while preserving nested events and guide isolation", async () => {
		const result = await script(`
			const [file, command] = await Promise.all([
				tools.read({ path: "src/items.json" }),
				tools.bash({ command: "printf 'local-ready'" })
			]);
			return { count: JSON.parse(file).length, output: command.output, exit: command.exit_code };
		`);
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain('"count":2');
		expect(text(result)).toContain('"output":"local-ready"');
		expect(text(result)).toContain('"exit":0');
		expect(
			events
				.filter((event) => event.parentToolCallId)
				.map((event) => event.toolName)
				.sort(),
		).toEqual(["bash", "read"]);
		const read = events.find((event) => event.toolName === "read");
		expect(read?.details ?? {}).not.toHaveProperty(READ_SCOPE_KEY);
		expect(text(result)).not.toContain("NESTED_GUIDE_MARKER");
		if (!read) throw new Error("Missing nested read event");
		const { parentToolCallId: _parent, ...direct } = read;
		const patch = await session.extensionRunner.emitToolResult(direct);
		expect(patch?.details).toHaveProperty(READ_SCOPE_KEY, {
			root: directory,
			path: join(directory, "src", "items.json"),
		});
	});

	it("scopes direct-read guides to the captured execution CWD, not a colliding startup path", async () => {
		for (const subdirectory of ["a", "src/a"]) {
			await mkdir(join(directory, subdirectory));
		}
		await writeFile(join(directory, "a", "file.txt"), "startup-source");
		await writeFile(join(directory, "a", "AGENTS.md"), "WRONG_GUIDE");
		await writeFile(join(directory, "src", "a", "file.txt"), "actual-source");
		await writeFile(join(directory, "src", "a", "AGENTS.md"), "CORRECT_GUIDE");
		const cwd = session.agent.state.tools.find((tool) => tool.name === "session_cwd");
		const read = session.agent.state.tools.find((tool) => tool.name === "read");
		if (!cwd || !read) throw new Error("Missing session-CWD tools");
		const signal = new AbortController().signal;
		await cwd.execute("move", { action: "push", path: "src" }, signal);
		const input = { path: "a/file.txt" };
		const result = await read.execute("direct-read", input, signal);
		expect(text(result)).toBe("actual-source");
		expect(result.details).toHaveProperty(READ_CWD_KEY, join(directory, "src"));
		// Later CWD changes must not alter scope for the result already produced.
		await cwd.execute("reset", { action: "reset" }, signal);
		const patch = await session.extensionRunner.emitToolResult({
			type: "tool_result",
			toolName: "read",
			toolCallId: "direct-read",
			input,
			content: result.content,
			details: result.details,
			isError: false,
		});
		expect(patch?.details).toHaveProperty(READ_SCOPE_KEY, {
			root: directory,
			path: join(directory, "src", "a", "file.txt"),
		});
		const details = patch?.details as {
			[READ_SCOPE_KEY]: { root: string; path: string };
			[READ_CWD_KEY]: string;
		};
		expect(details[READ_CWD_KEY]).toBe(join(directory, "src"));
		const projected = await session.extensionRunner.emitContext([
			{
				role: "toolResult",
				toolName: "read",
				toolCallId: "direct-read",
				content: result.content,
				details,
				isError: false,
				timestamp: Date.now(),
			},
		]);
		expect(JSON.stringify(projected)).toContain("CORRECT_GUIDE");
		expect(JSON.stringify(projected)).not.toContain("WRONG_GUIDE");
	});

	it("filters output larger than the model-facing bash limit inside the sandbox", async () => {
		const command = `node -e 'console.log(JSON.stringify(Array.from({length:4000},(_,id)=>({id,label:"local-fixture"}))))'`;
		const result = await script(`
			const r = await tools.bash({ command: ${JSON.stringify(command)} });
			const rows = JSON.parse(r.output);
			return { count: rows.length, last: rows.at(-1).id, exit: r.exit_code };
		`);
		expect(result.isError, text(result)).not.toBe(true);
		expect(text(result)).toContain('"count":4000');
		expect(text(result)).toContain('"last":3999');
		expect(Buffer.byteLength(text(result))).toBeLessThan(1024);
	});

	it("retains successful calls when a sibling fails and reports nonzero shell exits", async () => {
		const result = await script(`
			const r = await Promise.allSettled([
				tools.read({ path: "src/items.json" }),
				tools.read({ path: "missing.json" })
			]);
			const shell = await tools.bash({ command: "printf 'expected-failure'; exit 7" });
			return { statuses: r.map(x => x.status), exit: shell.exit_code, output: shell.output };
		`);
		expect(result.isError).not.toBe(true);
		expect(text(result)).toContain('"statuses":["fulfilled","rejected"]');
		expect(text(result)).toContain('"exit":7');
		expect(text(result)).toContain("expected-failure");
	});

	it("runs nested calls through permission hooks", async () => {
		const result = await script('await tools.bash({ command: "blocked-fixture" });');
		expect(result.isError).toBe(true);
		expect(text(result)).toContain("fixture permission denied");
	});

	it("honors session-cwd changes for calls through codemode", async () => {
		const changed = await script(
			'await tools.session_cwd({ action: "push", path: "src" }); return await tools.read({ path: "items.json" });',
		);
		expect(changed.isError, text(changed)).not.toBe(true);
		expect(text(changed)).toContain('"id":2');
		const reset = await script('return await tools.session_cwd({ action: "reset" });');
		expect(text(reset)).toContain(directory);
	});
});
