import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LocalTranslator } from "../extensions/translate/backend.js";

const mocks = vi.hoisted(() => ({ spawn: vi.fn(), access: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));
vi.mock("node:fs/promises", () => ({ access: mocks.access }));

let child: EventEmitter & { kill: ReturnType<typeof vi.fn> };
let response: Record<string, unknown>;
let tokens: number[];
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
	mocks.access.mockResolvedValue(undefined);
	response = { content: "Fix the error.", stopped_eos: true, truncated: false };
	tokens = [1, 2, 3];
	mocks.spawn.mockImplementation((_binary: string, args: string[]) => {
		const port = args[args.indexOf("--port") + 1];
		const stderr = new PassThrough();
		child = Object.assign(new EventEmitter(), {
			pid: 123,
			exitCode: null,
			signalCode: null,
			stdout: new PassThrough(),
			stderr,
			kill: vi.fn(() => {
				queueMicrotask(() => {
					child.emit("exit", 0);
					child.emit("close", 0);
				});
				return true;
			}),
		});
		queueMicrotask(() => stderr.write(`srv llama_server: listening on http://127.0.0.1:${port}\n`));
		return child;
	});
	fetchMock = vi.fn(async (url: string) => {
		const data = url.endsWith("/health")
			? { status: "ok" }
			: url.endsWith("/tokenize")
				? { tokens }
				: response;
		return new Response(JSON.stringify(data));
	});
	vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
	vi.unstubAllGlobals();
	vi.unstubAllEnvs();
	vi.clearAllMocks();
});

describe("owned local translation runtime", () => {
	it("spawns once, binds/authenticates only on loopback, neutralizes runner environment and stops its process", async () => {
		vi.stubEnv("LLAMA_ARG_MODEL_URL", "https://should-not-be-used.invalid/model");
		const translator = new LocalTranslator();
		try {
			await Promise.all([translator.start(), translator.start()]);
			expect(await translator.translate("Corrija o erro.")).toBe("Fix the error.");
			expect(mocks.spawn).toHaveBeenCalledTimes(1);
			const [, args, options] = mocks.spawn.mock.calls[0] ?? [];
			expect(args).toEqual(expect.arrayContaining(["127.0.0.1", "--offline", "--no-webui", "--no-jinja"]));
			expect(options.env.LLAMA_ARG_MODEL_URL).toBeUndefined();
			expect(options.env.LLAMA_API_KEY).toHaveLength(48);
			for (const [url, request] of fetchMock.mock.calls) {
				expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\//u);
				expect(request.redirect).toBe("error");
				expect(request.headers.Authorization).toBe(`Bearer ${options.env.LLAMA_API_KEY}`);
			}
			const completion = fetchMock.mock.calls.find(([url]) => url.endsWith("/completion"));
			expect(JSON.parse(completion?.[1].body)).toMatchObject({
				prompt: tokens,
				temperature: 0,
				stream: false,
			});
		} finally {
			await translator.stop();
		}
		expect(child.kill).toHaveBeenCalledWith("SIGTERM");
		await translator.stop();
		expect(child.kill).toHaveBeenCalledTimes(1);
	});

	it("refuses to start without the model and does not download anything", async () => {
		mocks.access.mockRejectedValueOnce(new Error("ENOENT"));
		await expect(new LocalTranslator().start()).rejects.toThrow("model missing");
		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("rejects truncated, empty and oversized responses and oversized token input", async () => {
		const translator = new LocalTranslator();
		try {
			await translator.start();
			for (const invalid of [
				{ content: "partial", stop_type: "limit" },
				{ content: "partial", truncated: true },
				{ content: "" },
				{ content: "a".repeat(128 * 1024) },
			]) {
				response = invalid;
				await expect(translator.translate("Corrija o erro.")).rejects.toThrow();
			}
			tokens = Array.from({ length: 1501 }, () => 1);
			await expect(translator.translate("Corrija o erro.")).rejects.toThrow("input budget");
		} finally {
			await translator.stop();
		}
	});

	it("cancels before spawning when shutdown races startup", async () => {
		const translator = new LocalTranslator();
		const start = translator.start();
		await translator.stop();
		await expect(start).rejects.toThrow();
		expect(mocks.spawn).not.toHaveBeenCalled();
	});
});
