import { describe, expect, it } from "vitest";
import { parseNameList } from "../extensions/subagent/agents.js";
import {
	assertBoundedText,
	DEFAULT_SUBAGENT_LIMITS,
	resolveSubagentLimits,
} from "../extensions/subagent/limits.js";
import { createTmuxObserver, isTmuxObservationAvailable } from "../extensions/subagent/tmux.js";

describe("subagent bounds and agent definitions", () => {
	it("loads bounded environment overrides and rejects unsafe values", () => {
		const limits = resolveSubagentLimits({
			PI_CORE_SUBAGENT_MAX_DEPTH: "5",
			PI_CORE_SUBAGENT_GLOBAL_CONCURRENCY: "7",
		});
		expect(limits.maxDepth).toBe(5);
		expect(limits.globalConcurrency).toBe(7);
		expect(limits.questionBytes).toBe(DEFAULT_SUBAGENT_LIMITS.questionBytes);
		expect(() => resolveSubagentLimits({ PI_CORE_SUBAGENT_MAX_DEPTH: "99" })).toThrow(
			"Invalid subagent limit",
		);
	});

	it("enforces UTF-8 byte limits rather than character counts", () => {
		expect(assertBoundedText(" ok ", "task", 2)).toBe("ok");
		expect(() => assertBoundedText("😀😀", "task", 7)).toThrow("8 bytes");
	});

	it("parses explicit child names from YAML strings or arrays", () => {
		expect(parseNameList("reviewer, scout, reviewer")).toEqual(["reviewer", "scout"]);
		expect(parseNameList(["worker", 3, "bad name"])).toEqual(["worker"]);
	});
});

describe("optional tmux observability", () => {
	it("does not invoke tmux or affect behavior when tmux is absent", () => {
		let calls = 0;
		const run = () => {
			calls++;
			throw new Error("tmux should not run");
		};
		expect(isTmuxObservationAvailable({}, run)).toBe(false);
		const observer = createTmuxObserver({ id: "aaaaaaaa", agent: "worker", env: {}, run });
		observer.status("running");
		observer.close();
		expect(calls).toBe(0);
	});

	it("degrades to a no-op if tmux probing fails inside tmux", () => {
		const observer = createTmuxObserver({
			id: "aaaaaaaa",
			agent: "worker",
			env: { TMUX: "/tmp/tmux", TMUX_PANE: "%1" },
			run: () => {
				throw new Error("missing binary");
			},
		});
		expect(() => observer.status("still running")).not.toThrow();
		expect(() => observer.close()).not.toThrow();
	});
});
