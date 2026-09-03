import { describe, expect, it } from "vitest";
import {
	clearProjectSkillMode,
	getSkillMode,
	parseConfig,
	resolveSkillMode,
	setGlobalSkillMode,
	setProjectSkillMode,
} from "../extensions/skill-manager/config.js";

describe("skill manager config", () => {
	it("defaults unknown skills to full", () => {
		expect(getSkillMode(parseConfig({}), "/work/project", "xray")).toBe("full");
	});

	it("resolves project, global, and default layers in order", () => {
		let config = parseConfig({ defaultMode: "searchable" });
		config = setGlobalSkillMode(config, "xray", "off");
		expect(resolveSkillMode(config, "/work/a", "xray")).toEqual({ mode: "off", source: "global" });
		config = setProjectSkillMode(config, "/work/a", "xray", "full");
		expect(resolveSkillMode(config, "/work/a", "xray")).toEqual({ mode: "full", source: "project" });
		expect(getSkillMode(config, "/work/b", "xray")).toBe("off");
		config = clearProjectSkillMode(config, "/work/a", "xray");
		expect(resolveSkillMode(config, "/work/a", "xray")).toEqual({ mode: "off", source: "global" });
	});

	it("migrates version 1 profiles without losing overrides", () => {
		const config = parseConfig({
			version: 1,
			profiles: { "/work": { skills: { xray: "name" } } },
		});
		expect(config.version).toBe(2);
		expect(resolveSkillMode(config, "/work", "xray")).toEqual({ mode: "name", source: "project" });
	});

	it("drops invalid persisted modes", () => {
		const config = parseConfig({ projects: { "/work": { skills: { good: "name", bad: "broken" } } } });
		expect(getSkillMode(config, "/work", "good")).toBe("name");
		expect(getSkillMode(config, "/work", "bad")).toBe("full");
	});
});
