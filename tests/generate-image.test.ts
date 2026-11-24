import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { generateImage } from "../extensions/generate-image/generate.js";

let home: string;
const request = vi.fn<typeof fetch>();
const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jJ1sAAAAASUVORK5CYII=";
beforeEach(async () => {
	home = await mkdtemp(join(tmpdir(), "pi-image-"));
	vi.stubGlobal("fetch", request.mockReset());
	await writeFile(
		join(home, "auth.json"),
		JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture", account_id: "test-account" } }),
	);
});
afterEach(async () => {
	vi.unstubAllGlobals();
	await rm(home, { recursive: true, force: true });
});
const run = () => generateImage("blue bird", home, join(home, "images"));
it("uses one fixed subscription request and returns a saved PNG", async () => {
	request.mockResolvedValue(Response.json({ data: [{ b64_json: png }] }));
	const path = await run();
	expect(await readFile(path)).toEqual(Buffer.from(png, "base64"));
	expect(request).toHaveBeenCalledExactlyOnceWith(
		"https://chatgpt.com/backend-api/codex/images/generations",
		expect.objectContaining({
			redirect: "error",
			headers: expect.objectContaining({
				authorization: "Bearer fixture",
				"ChatGPT-Account-ID": "test-account",
			}),
		}),
	);
	expect(JSON.parse(String(request.mock.calls[0][1]?.body))).toMatchObject({
		prompt: "blue bird",
		quality: "auto",
		size: "auto",
		background: "auto",
	});
});
it("rejects API key credentials before making a request", async () => {
	await writeFile(join(home, "auth.json"), JSON.stringify({ auth_mode: "apikey", OPENAI_API_KEY: "test" }));
	await expect(run()).rejects.toThrow("codex login");
	expect(request).not.toHaveBeenCalled();
});
it("does not retry a rejection or leak the response body", async () => {
	request.mockResolvedValue(new Response("secret diagnostic", { status: 401 }));
	await expect(run()).rejects.toThrow(
		/^Codex image generation failed \(HTTP 401\)\. Renew your ChatGPT login with `codex login`\.$/,
	);
	expect(request).toHaveBeenCalledTimes(1);
});
it("rejects non-image responses without returning raw data", async () => {
	request.mockResolvedValue(Response.json({ data: [{ b64_json: "bm90LXBuZw==" }] }));
	await expect(run()).rejects.toThrow("did not return a PNG");
});
