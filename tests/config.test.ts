import { describe, expect, it } from "vitest";
import { getSkillMode, parseConfig, setSkillMode } from "../extensions/skill-manager/config.js";

describe("skill manager config", () => {
	it("defaults unknown skills to full", () => {
		expect(getSkillMode(parseConfig({}), "/work/project", "xray")).toBe("full");
	});

	it("stores isolated per-CWD overrides", () => {
		let config = parseConfig({ defaultMode: "searchable" });
		config = setSkillMode(config, "/work/a", "xray", "off");
		expect(getSkillMode(config, "/work/a", "xray")).toBe("off");
		expect(getSkillMode(config, "/work/b", "xray")).toBe("searchable");
	});

	it("drops invalid persisted modes", () => {
		const config = parseConfig({ profiles: { "/work": { skills: { good: "name", bad: "broken" } } } });
		expect(getSkillMode(config, "/work", "good")).toBe("name");
		expect(getSkillMode(config, "/work", "bad")).toBe("full");
	});
});
