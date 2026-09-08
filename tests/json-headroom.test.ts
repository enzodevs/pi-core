import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createJsonCompressor, MAX_JSON_BYTES, runWorker } from "../extensions/json-headroom/bridge.js";
import { compactToolResult } from "../extensions/json-headroom/compact.js";
import jsonHeadroom from "../extensions/json-headroom/index.js";
import { saveOriginal } from "../extensions/json-headroom/originals.js";
import { getHeadroomPaths } from "../extensions/json-headroom/paths.mjs";
import { getStoragePaths } from "../extensions/skill-manager/paths.js";

const text = JSON.stringify(
	Array.from({ length: 300 }, (_, id) => ({ id, description: "normal service healthy" })),
);
const event = (changes: Partial<ToolResultEvent> = {}): ToolResultEvent => ({
	type: "tool_result",
	toolName: "bash",
	toolCallId: "call1",
	input: { command: "fetch-services --json" },
	content: [{ type: "text", text }],
	details: { code: 0 },
	isError: false,
	...changes,
});
const directories: string[] = [];
async function temporary() {
	const directory = await mkdtemp(join(tmpdir(), "pi-json-test-"));
	directories.push(directory);
	return directory;
}
afterEach(async () => {
	await Promise.all(
		directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
	);
});

describe("JSON compaction boundary", () => {
	it("patches content only, keeps the source immutable, and provides an original reference", async () => {
		const source = event();
		const snapshot = structuredClone(source);
		const compress = vi.fn(async () => "[300]{id:int}\n0\n");
		const save = vi.fn(async () => ({ path: "/private/original.json", discard: vi.fn() }));
		const patch = await compactToolResult(source, { compress, save });
		expect(source).toEqual(snapshot);
		expect(Object.keys(patch ?? {})).toEqual(["content"]);
		expect(patch?.content[0]).toMatchObject({
			text: expect.stringContaining('Original JSON: "/private/original.json"'),
		});
		expect(save).toHaveBeenCalledWith(text);
	});

	it("never dispatches protected, non-JSON, failed, partial, or unbounded results", async () => {
		const compress = vi.fn(async () => "compressed");
		const save = vi.fn(async () => ({ path: "/original", discard: vi.fn() }));
		const cases = [
			event({ toolName: "read" }),
			event({ toolName: "edit" }),
			event({ toolName: "write" }),
			event({ isError: true }),
			event({ details: { code: 7 } }),
			event({ details: { exitCode: 7 } }),
			event({ details: { truncation: { truncated: true } } }),
			event({ details: { fullOutputPath: "/log" } }),
			event({ content: [{ type: "text", text: "[]" }] }),
			event({ content: [{ type: "text", text: "[".repeat(9000) }] }),
			event({ content: [{ type: "text", text: "x".repeat(9000) }] }),
			event({ content: [{ type: "text", text: JSON.stringify("x".repeat(MAX_JSON_BYTES)) }] }),
			event({
				content: [
					{ type: "text", text },
					{ type: "text", text: "stderr: failure" },
				],
			}),
			event({ content: [{ type: "image", data: "abc", mimeType: "image/png" }] }),
		];
		for (const input of cases) expect(await compactToolResult(input, { compress, save })).toBeUndefined();
		expect(compress).not.toHaveBeenCalled();
		expect(save).not.toHaveBeenCalled();
	});

	it("preserves original exit 7 and middle failure evidence without calling the worker", async () => {
		const input = event({
			isError: true,
			details: { code: 7 },
			content: [{ type: "text", text: `${text}\nMIDDLE_CAUSE_7\n${text}` }],
		});
		const patch = await compactToolResult(input, { compress: vi.fn(), save: vi.fn() });
		expect(patch).toBeUndefined();
		expect(input.details).toEqual({ code: 7 });
		expect(input.content[0]).toMatchObject({ text: expect.stringContaining("MIDDLE_CAUSE_7") });
	});

	it("falls back for failures, insufficient savings, unavailable originals, and cancellation", async () => {
		const save = vi.fn(async () => ({ path: "/original", discard: vi.fn() }));
		for (const compress of [
			async () => undefined,
			async () => text,
			async () => {
				throw new Error("worker failed");
			},
		]) {
			expect(await compactToolResult(event(), { compress, save })).toBeUndefined();
		}
		expect(save).not.toHaveBeenCalled();
		expect(
			await compactToolResult(event(), {
				compress: async () => "small",
				save: async () => {
					throw new Error("disk full");
				},
			}),
		).toBeUndefined();
		const controller = new AbortController();
		controller.abort();
		expect(await compactToolResult(event(), { compress: vi.fn(), save }, controller.signal)).toBeUndefined();
	});

	it("stores exact private originals atomically and does not evict existing references", async () => {
		const directory = await temporary();
		const original = `${text}\n`;
		const { path: file } = await saveOriginal(directory, original);
		expect(await readFile(file, "utf8")).toBe(original);
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		expect(await readdir(directory)).toEqual([file.split("/").at(-1)]);
		await writeFile(join(directory, "budget.json"), "", { mode: 0o600 });
		const { truncate } = await import("node:fs/promises");
		await truncate(join(directory, "budget.json"), 32 * 1024 * 1024);
		await expect(saveOriginal(directory, "[]")).rejects.toThrow("full");
		expect(await readFile(file, "utf8")).toBe(original);
	});

	it("rolls back unpublished originals without deleting previous identical references", async () => {
		const directory = await temporary();
		const previous = await saveOriginal(directory, text);
		const controller = new AbortController();
		const result = await compactToolResult(
			event(),
			{
				compress: async () => "small",
				save: async (input) => {
					const reference = await saveOriginal(directory, input);
					controller.abort();
					return reference;
				},
			},
			controller.signal,
		);
		expect(result).toBeUndefined();
		expect(await readdir(directory)).toEqual([previous.path.split("/").at(-1)]);
		expect(await readFile(previous.path, "utf8")).toBe(text);
		const discard = vi.fn(async () => {});
		expect(
			await compactToolResult(event(), {
				compress: async () => "small",
				save: async () => ({ path: "x".repeat(text.length), discard }),
			}),
		).toBeUndefined();
		expect(discard).toHaveBeenCalledOnce();
	});

	it("uses the same Pi state root and platform-correct venv layout in all entry points", () => {
		const base = getStoragePaths("/test-home").directory;
		expect(getHeadroomPaths("/test-home", "linux").python).toBe(
			join(base, "headroom-json", "venv", "bin", "python"),
		);
		expect(getHeadroomPaths("/test-home", "win32").python).toBe(
			join(base, "headroom-json", "venv", "Scripts", "python.exe"),
		);
	});

	it("is opt-in and never registers a history rewrite or another model-facing tool", async () => {
		const handlers = new Map<string, (...args: unknown[]) => unknown>();
		const registerFlag = vi.fn();
		const registerTool = vi.fn();
		jsonHeadroom({
			on: (name: string, handler: (...args: unknown[]) => unknown) => handlers.set(name, handler),
			getFlag: () => false,
			registerFlag,
			registerTool,
			registerCommand: vi.fn(),
		} as unknown as ExtensionAPI);
		expect(registerFlag).toHaveBeenCalledWith("headroom-json", expect.objectContaining({ default: false }));
		expect([...handlers.keys()]).toEqual(["session_start", "tool_result"]);
		expect(registerTool).not.toHaveBeenCalled();
		const prefix = [event(), event({ toolCallId: "earlier" })];
		const snapshot = structuredClone(prefix);
		expect(await handlers.get("tool_result")?.(event(), {})).toBeUndefined();
		expect(prefix).toEqual(snapshot);
		const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
		expect(manifest.pi.extensions.join("\n")).not.toContain("context-guard");
	});
});

describe("bounded offline worker bridge", () => {
	it("admits at most two workers without queuing and releases capacity after failures", async () => {
		let release!: () => void;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const worker = vi.fn(async () => {
			await pending;
			return "ok";
		});
		const compress = createJsonCompressor(worker);
		const first = compress("one");
		const second = compress("two");
		expect(await compress("overflow")).toBeUndefined();
		expect(worker).toHaveBeenCalledTimes(2);
		release();
		expect(await Promise.all([first, second])).toEqual(["ok", "ok"]);
		expect(await compress("next")).toBe("ok");
		const failing = createJsonCompressor(async () => {
			throw new Error("failed");
		});
		for (let i = 0; i < 3; i++) await expect(failing("input")).rejects.toThrow("failed");
	});
	const reply = `let input=''; process.stdin.setEncoding('utf8'); process.stdin.on('data',c=>input+=c); process.stdin.on('end',()=>process.stdout.write(JSON.stringify({sha256:require('node:crypto').createHash('sha256').update(input).digest('hex'),text:'ok'})));`;
	it("verifies the response is bound to the exact input", async () => {
		expect(await runWorker(process.execPath, ["-e", reply], text)).toBe("ok");
		expect(
			await runWorker(process.execPath, ["-e", reply.replace("digest('hex')", "digest('base64')")], text),
		).toBeUndefined();
	});
	it("falls back for missing workers, bad protocol, nonzero exit and excessive output", async () => {
		expect(await runWorker("/does/not/exist", [], text)).toBeUndefined();
		for (const script of [
			"process.stdout.write('bad-json')",
			"process.exit(7)",
			"process.stdout.write('x'.repeat(600000))",
			"process.stderr.write('x'.repeat(9000))",
		]) {
			expect(await runWorker(process.execPath, ["-e", script], text)).toBeUndefined();
		}
	});
	it("kills hung or cancelled workers", async () => {
		expect(
			await runWorker(process.execPath, ["-e", "setInterval(()=>{},1000)"], text, undefined, 30),
		).toBeUndefined();
		const controller = new AbortController();
		const result = runWorker(process.execPath, ["-e", "setInterval(()=>{},1000)"], text, controller.signal);
		controller.abort();
		expect(await result).toBeUndefined();
	});
});
