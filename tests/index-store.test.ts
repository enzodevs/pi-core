import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SkillIndexStore } from "../extensions/skill-manager/index-store.js";

const indexed = {
	name: "xray",
	description: "Trace code",
	filePath: "/skills/xray/SKILL.md",
	baseDir: "/skills/xray",
	mode: "searchable" as const,
};

describe("skill index store", () => {
	it("persists and restores a project index", async () => {
		const directory = await mkdtemp(join(tmpdir(), "pi-core-"));
		const path = join(directory, "nested", "index.json");
		const writer = new SkillIndexStore(path);
		await writer.update("/work/project", [indexed]);
		const reader = new SkillIndexStore(path);
		await reader.load();
		expect(reader.get("/work/project")).toEqual([indexed]);
		expect(JSON.parse(await readFile(path, "utf8")).version).toBe(1);
	});
});
