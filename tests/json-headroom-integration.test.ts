import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ToolResultEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { compressJson } from "../extensions/json-headroom/bridge.js";
import { compactToolResult } from "../extensions/json-headroom/compact.js";
import { saveOriginal } from "../extensions/json-headroom/originals.js";

// The ordinary Node suite needs no Python installation. make headroom-test opts in.
describe.skipIf(!process.env.PI_CORE_HEADROOM_PYTHON)("real Headroom subprocess", () => {
	it("compacts JSON, keeps middle evidence and recovers byte-exact originals", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-headroom-integration-"));
		try {
			const rows = Array.from({ length: 300 }, (_, id) => ({
				id,
				name: `service-${id}`,
				description: "normal background service",
			}));
			const expired = rows.at(173);
			const override = rows.at(217);
			if (!expired || !override) throw new Error("integration fixture rows are missing");
			expired.description = "CERT_RENEWAL_EXPIRED_173";
			override.description = "ROUTING_OVERRIDE_217";
			const text = JSON.stringify(rows, null, 2);
			const event: ToolResultEvent = {
				type: "tool_result",
				toolName: "bash",
				toolCallId: "call1",
				input: {},
				content: [{ type: "text", text }],
				details: { code: 0 },
				isError: false,
			};
			let saved = "";
			const result = await compactToolResult(event, {
				compress: compressJson,
				save: async (input) => {
					const reference = await saveOriginal(directory, input);
					saved = reference.path;
					return reference;
				},
			});
			expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("CERT_RENEWAL_EXPIRED_173") });
			expect(result?.content[0]).toMatchObject({ text: expect.stringContaining("ROUTING_OVERRIDE_217") });
			expect(result?.content[0]).toMatchObject({ text: expect.stringContaining(saved) });
			expect(await readFile(saved, "utf8")).toBe(text);
			expect(event.content[0]).toEqual({ type: "text", text });
			expect(event.details).toEqual({ code: 0 });
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
	it("does not compress ambiguous JSON or dependency error output", async () => {
		expect(await compressJson('{"x":1,"x":2}')).toBeUndefined();
		expect(
			await compressJson(JSON.stringify(Array.from({ length: 30 }, () => ({ big: "value", nested: {} })))),
		).toBeUndefined();
	});
});
