import { describe, expect, it } from "vitest";
import { boundSudoOutput, runSudo } from "../extensions/sudo/index.js";

describe("boundSudoOutput", () => {
	it("keeps short output unchanged", () => {
		expect(boundSudoOutput("hello")).toEqual({ content: "hello", truncated: false });
	});

	it("keeps the tail and marks large output", () => {
		const output = `${"x".repeat(60 * 1024)}\nlast`;
		const result = boundSudoOutput(output);
		expect(result.truncated).toBe(true);
		expect(result.content).toContain("[truncated: showing output tail;");
		expect(result.content.endsWith("last")).toBe(true);
		expect(Buffer.byteLength(result.content)).toBeLessThan(51 * 1024);
	});

	it("does not spawn when cancellation already happened", async () => {
		const controller = new AbortController();
		controller.abort();
		await expect(
			runSudo("true", process.cwd(), Buffer.from("unused"), controller.signal, () => {
				throw new Error("must not spawn");
			}),
		).rejects.toMatchObject({ name: "AbortError" });
	});

	it("caps output by line count", () => {
		const output = Array.from({ length: 2_100 }, (_, index) => String(index)).join("\n");
		const result = boundSudoOutput(output);
		expect(result.truncated).toBe(true);
		expect(result.content).not.toContain("\n0\n");
		expect(result.content.endsWith("2099")).toBe(true);
	});
});
