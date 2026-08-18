import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { chooseFooterParts, entryCost, messageCost } from "../extensions/footer/index.js";

describe("minimal footer layout", () => {
	const parts = {
		model: "◇ gpt-5.6-terra · low",
		branch: "feature/footer",
		context: "ctx 18%",
		cost: "$0.14",
		statuses: ["⚡ fast", "⚙ 2 agents"],
	};

	it("keeps all signals when space is available", () => {
		expect(chooseFooterParts(120, parts)).toEqual({
			left: "◇ gpt-5.6-terra · low · git:feature/footer",
			right: "ctx 18% · $0.14 · ⚡ fast · ⚙ 2 agents",
		});
	});

	it("drops optional details before active statuses", () => {
		const compact = chooseFooterParts(55, parts);
		expect(compact.right).not.toContain("$0.14");
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

	it("counts assistant and nested tool-result usage", () => {
		expect(messageCost({ role: "assistant", usage: { cost: { total: 0.2 } } })).toBe(0.2);
		expect(messageCost({ role: "toolResult", usage: { cost: { total: 0.3 } } })).toBe(0.3);
		expect(messageCost({ role: "user", usage: { cost: { total: 1 } } })).toBe(0);
	});

	it("counts compaction and branch-summary usage", () => {
		expect(entryCost({ type: "compaction", usage: { cost: { total: 0.4 } } })).toBe(0.4);
		expect(entryCost({ type: "branch_summary", usage: { cost: { total: 0.5 } } })).toBe(0.5);
		expect(entryCost({ type: "model_change", usage: { cost: { total: 1 } } })).toBe(0);
	});
});
