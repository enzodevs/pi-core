import { describe, expect, it } from "vitest";
import { truncateUtf8 } from "../extensions/subagent/index.js";

describe("background agent handoff truncation", () => {
	it("leaves bounded output unchanged", () => {
		expect(truncateUtf8("concise", 16)).toBe("concise");
	});

	it("strictly caps UTF-8 output and reports omitted bytes", () => {
		const output = truncateUtf8("😀".repeat(100), 80);
		expect(output).not.toContain("�");
		expect(output).toContain("bytes omitted]");
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(80);
	});

	it("caps the complete status envelope", () => {
		const output = truncateUtf8(`agent: scout\nstatus: complete\n\n${"x".repeat(500)}`, 96);
		expect(output).toMatch(/^agent: scout\nstatus: complete/);
		expect(Buffer.byteLength(output)).toBeLessThanOrEqual(96);
	});
});
