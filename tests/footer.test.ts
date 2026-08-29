import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { chooseFooterParts } from "../extensions/footer/index.js";

describe("minimal footer layout", () => {
	const parts = {
		model: "◇ gpt-5.6-terra · low",
		sessionName: "Add automatic session titles",
		branch: "feature/footer",
		context: "ctx 18%",
		statuses: ["⚡ fast", "⚙ 2 agents"],
	};

	it("keeps all signals when space is available", () => {
		expect(chooseFooterParts(140, parts)).toEqual({
			left: "◇ gpt-5.6-terra · low · Add automatic session titles · git:feature/footer",
			right: "ctx 18% · ⚡ fast · ⚙ 2 agents",
		});
	});

	it("drops optional details before active statuses", () => {
		const compact = chooseFooterParts(55, parts);
		expect(compact.left).not.toContain("Add automatic session titles");
		expect(compact.left).not.toContain("git:feature/footer");
		expect(compact.right).toContain("⚡ fast");
		expect(compact.right).toContain("⚙ 2 agents");
	});

	it("uses a status-only layout when statuses consume the narrow width", () => {
		const compact = chooseFooterParts(20, parts);
		expect(compact.left).toBe("");
		expect(compact.right).toContain("⚡ fast");
		expect(compact.right).toContain("⚙ 2 agents");
		expect(visibleWidth(compact.right)).toBeLessThanOrEqual(20);
	});

	it("marks unavoidable status truncation explicitly", () => {
		const compact = chooseFooterParts(12, parts);
		expect(compact.left).toBe("");
		expect(compact.right).toContain("…");
		expect(visibleWidth(compact.right)).toBeLessThanOrEqual(12);
	});

	it("does not invent a session label for unnamed sessions", () => {
		const unnamed = chooseFooterParts(140, { ...parts, sessionName: undefined });
		expect(unnamed.left).toBe("◇ gpt-5.6-terra · low · git:feature/footer");
	});
});
