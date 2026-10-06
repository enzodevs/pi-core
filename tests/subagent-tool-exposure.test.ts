import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentSession,
	type AgentSessionEvent,
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_SUBAGENT_LIMITS } from "../extensions/subagent/limits.js";
import {
	ASK_PARENT_PROTOCOL,
	createChildLineage,
	encodeChildLineage,
	RpcEventTracker,
} from "../extensions/subagent/protocol.js";
import { buildChildTools, SUBAGENT_EXTENSION_PATH } from "../extensions/subagent/runner.js";

let directory: string;
let session: AgentSession | undefined;
let calls = 0;

function currentSession(): AgentSession {
	if (!session) throw new Error("Missing child session");
	return session;
}

function issuedMessage(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
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
	};
}

async function script(code: string, signal = new AbortController().signal) {
	const child = currentSession();
	const tool = child.agent.state.tools.find((tool) => tool.name === "codemode");
	if (!tool) throw new Error("Default child codemode missing");
	const id = `script-${++calls}`;
	const message = issuedMessage([{ type: "toolCall", id, name: "codemode", arguments: { code } }]);
	child.sessionManager.appendMessage(message);
	child.agent.state.messages = [message];
	const result = await tool.execute(id, { code }, signal);
	const text = result.content
		.filter((part) => part.type === "text")
		.map((part) => part.text)
		.join("\n");
	return { result, text };
}

beforeEach(async () => {
	session = undefined;
	directory = await mkdtemp(join(tmpdir(), "pi-core-child-codemode-"));
	await writeFile(join(directory, "items.json"), JSON.stringify([{ id: 1 }, { id: 2 }]));
	await writeFile(join(directory, "note.txt"), "local fixture");
	const lineage = createChildLineage({
		parent: null,
		runId: "11111111",
		agent: "reader",
		allowedChildren: [],
		limits: DEFAULT_SUBAGENT_LIMITS,
		registryPath: join(directory, "concurrency.json"),
	});
	vi.stubEnv("PI_CORE_SUBAGENT_CONTEXT", encodeChildLineage(lineage));
	// Do not bind this synthetic lineage to a real inherited child sidecar.
	vi.stubEnv("PI_CORE_SUBAGENT_CHANNEL", "");
	vi.stubEnv("PI_CORE_SUBAGENT_CHANNEL_TOKEN", "");
	const settingsManager = SettingsManager.inMemory({ defaultTools: [], codemode: { mode: "only" } });
	const loader = new DefaultResourceLoader({
		cwd: directory,
		agentDir: join(directory, "agent"),
		settingsManager,
		noExtensions: true,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
		additionalExtensionPaths: [SUBAGENT_EXTENSION_PATH],
		extensionFactories: [
			(pi) => {
				pi.on("tool_call", (event) => {
					if (event.toolName === "read" && event.input.path === "blocked.json") {
						return { block: true, reason: "fixture permission denied" };
					}
					return undefined;
				});
			},
		],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	({ session } = await createAgentSession({
		cwd: directory,
		agentDir: join(directory, "agent"),
		resourceLoader: loader,
		settingsManager,
		sessionManager: SessionManager.inMemory(directory),
		tools: buildChildTools(
			{
				name: "reader",
				description: "reader",
				tools: ["read"],
				children: [],
				systemPrompt: "read",
				source: "bundled",
				filePath: "/reader.md",
			},
			lineage,
		),
	}));
	await session.bindExtensions({});
});

afterEach(async () => {
	session?.dispose();
	vi.unstubAllEnvs();
	await rm(directory, { recursive: true, force: true });
});

describe("default child codemode (real upstream sandbox, no provider requests)", () => {
	it("works without parent settings or flags, keeps direct tools, and does not widen permissions", async () => {
		const child = currentSession();
		expect(child.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "codemode", "ask_parent"]));
		// Child on-mode overrides ambient only-mode, without adding prompt instructions.
		expect(child.agent.state.tools.map((tool) => tool.name)).toEqual(
			expect.arrayContaining(["read", "codemode", "ask_parent"]),
		);
		expect(child.getCallableToolNames()).toEqual(["read"]);
		const { result, text } = await script(
			'return { models: typeof models, write: "write" in tools, bash: "bash" in tools, ask: "ask_parent" in tools, recursive: "codemode" in tools };',
		);
		expect(result.isError, text).not.toBe(true);
		expect(text).toContain('"models":"undefined"');
		for (const name of ["write", "bash", "ask", "recursive"]) expect(text).toContain(`"${name}":false`);
		const rejected = await script('await tools.write({ path: "items.json", content: "changed" });');
		expect(rejected.result.isError).toBe(true);
		expect(JSON.parse(await readFile(join(directory, "items.json"), "utf8"))).toHaveLength(2);
	});

	it("receives image blocks from read without exposing base64 as text", async () => {
		const png =
			"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADElEQVQImWP4z8AAAAMBAQCc479ZAAAAAElFTkSuQmCC";
		await writeFile(join(directory, "pixel.png"), Buffer.from(png, "base64"));
		const { result, text } = await script(`
			const block = await tools.read({ path: "pixel.png" });
			return { type: block.type, mimeType: block.mimeType, hasData: block.data.length > 0 };
		`);
		expect(result.isError, text).not.toBe(true);
		expect(text).toContain('"type":"image"');
		expect(text).toContain('"mimeType":"image/png"');
		expect(text).toContain('"hasData":true');
		expect(text).not.toContain(png);
	});

	it("batches reads, filters output locally, and preserves the RPC event stream", async () => {
		const events: AgentSessionEvent[] = [];
		const unsubscribe = currentSession().subscribe((event) => events.push(event));
		const { result, text } = await script(`
			const [items, note] = await Promise.all([
				tools.read({ path: "items.json" }), tools.read({ path: "note.txt" })
			]);
			return { count: JSON.parse(items).length, noteLength: note.length };
		`);
		expect(result.isError, text).not.toBe(true);
		expect(text).toContain('"count":2');
		expect(text).not.toContain("local fixture");
		unsubscribe();
		const ends = events.filter((event) => event.type === "tool_execution_end");
		expect(ends).toHaveLength(2);
		for (const end of ends)
			expect(end).toMatchObject({ toolName: "read", parentToolCallId: expect.any(String) });
		const tracker = new RpcEventTracker(DEFAULT_SUBAGENT_LIMITS.questionBytes);
		for (const event of events) expect(tracker.consume(event)).toBeNull();
		expect(tracker.consume({ type: "agent_settled" })).toEqual({
			type: "settled",
			waiting: false,
			output: "",
		});
	});

	it("preserves partial successes and runs nested calls through permission hooks", async () => {
		const { result, text } = await script(`
			const r = await Promise.allSettled([
				tools.read({ path: "items.json" }), tools.read({ path: "blocked.json" })
			]);
			return { statuses: r.map(x => x.status), reason: String(r[1].reason) };
		`);
		expect(result.isError, text).not.toBe(true);
		expect(text).toContain('"statuses":["fulfilled","rejected"]');
		expect(text).toContain("fixture permission denied");
	});

	it("honors cancellation without losing the child tool loadout", async () => {
		const controller = new AbortController();
		controller.abort();
		const { result } = await script('await tools.read({ path: "items.json" });', controller.signal);
		expect(result.isError).toBe(true);
		const next = await script('return JSON.parse(await tools.read({ path: "items.json" })).length;');
		expect(next.result.isError, next.text).not.toBe(true);
		expect(next.text).toContain("2");
	});

	it("keeps ask_parent outside scripts and accepts larger direct questions", async () => {
		const denied = await script('await tools.ask_parent({ question: "Not inside a script" });');
		expect(denied.result.isError).toBe(true);
		const ask = currentSession().agent.state.tools.find((tool) => tool.name === "ask_parent");
		if (!ask) throw new Error("Missing direct ask_parent");
		const question = "q".repeat(2048);
		const result = await ask.execute("ask", { question }, new AbortController().signal);
		expect(result.details).toMatchObject({ protocol: ASK_PARENT_PROTOCOL, question });
		expect(result.terminate).toBe(true);
	});

	it("blocks codemode siblings when a direct parent question ends the turn", async () => {
		const child = currentSession();
		const message = issuedMessage([
			{ type: "toolCall", id: "code", name: "codemode", arguments: { code: "return 1" } },
			{ type: "toolCall", id: "ask", name: "ask_parent", arguments: { question: "Which API?" } },
		]);
		child.sessionManager.appendMessage(message);
		const blocked = await child.extensionRunner.emitToolCall({
			type: "tool_call",
			toolName: "codemode",
			toolCallId: "code",
			input: { code: "return 1" },
		});
		expect(blocked).toMatchObject({ block: true, terminate: true });
	});
});
