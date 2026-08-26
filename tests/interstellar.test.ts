import { readFileSync } from "node:fs";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { interstellarHeader } from "../extensions/interstellar/index.js";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

describe("interstellar package resources", () => {
	it("registers the theme in the Pi package manifest", () => {
		const manifest = JSON.parse(readFileSync("package.json", "utf8")) as {
			pi?: { themes?: string[] };
		};
		expect(manifest.pi?.themes).toContain("./themes/interstellar.json");
	});
});

describe("interstellar header", () => {
	it("uses the orbital π artwork on wide terminals", () => {
		const lines = interstellarHeader(theme, 80);
		expect(lines.join("\n")).toContain("π");
		expect(lines.join("\n")).toContain("coding agent · clear intent");
	});

	it("uses a compact, width-safe header on narrow terminals", () => {
		const lines = interstellarHeader(theme, 20);
		expect(lines.join("\n")).toContain("coding agent");
		for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(20);
	});
});
