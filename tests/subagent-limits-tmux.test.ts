import { describe, expect, it } from "vitest";
import { parseNameList } from "../extensions/subagent/agents.js";
import {
	assertBoundedText,
	DEFAULT_SUBAGENT_LIMITS,
	resolveSubagentLimits,
} from "../extensions/subagent/limits.js";
import {
	buildTmuxLaunchArgs,
	isTmuxTuiAvailable,
	TmuxClient,
	TmuxLaunchError,
} from "../extensions/subagent/tmux.js";

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

describe("interactive tmux backend probing and launch", () => {
	it("selects no tmux backend without a real parent pane", () => {
		let calls = 0;
		expect(
			isTmuxTuiAvailable({}, () => {
				calls++;
				return "";
			}),
		).toBe(false);
		expect(calls).toBe(0);
		expect(isTmuxTuiAvailable({ TMUX: "/tmp/tmux", TMUX_PANE: "not-a-pane" }, () => "%1")).toBe(false);
	});

	it("launches a detached split whose command is the actual child Pi invocation", () => {
		const args = buildTmuxLaunchArgs(
			{
				parentPane: "%5",
				cwd: "/repo",
				title: "agent:worker:abcd1234",
				channelDirectory: "/private/channel",
				channelToken: "token",
				environment: { PI_CORE_SUBAGENT_CONTEXT: "lineage" },
				command: "/usr/bin/pi",
				args: ["--session", "/sessions/child.jsonl", "@/private/channel/task.md"],
			},
			"/package/pane-host.sh",
		);
		expect(args.slice(0, 11)).toEqual([
			"split-window",
			"-d",
			"-h",
			"-t",
			"%5",
			"-c",
			"/repo",
			"-P",
			"-F",
			"#{pane_id}",
			"-e",
		]);
		expect(args).toContain("PI_CORE_SUBAGENT_CONTEXT=lineage");
		expect(args.slice(-4)).toEqual([
			"/usr/bin/pi",
			"--session",
			"/sessions/child.jsonl",
			"@/private/channel/task.md",
		]);
		expect(args.join(" ")).not.toContain("tail -n");
	});

	it("fails launch atomically when tmux does not return a pane", () => {
		const client = new TmuxClient({ TMUX: "/tmp/tmux", TMUX_PANE: "%5" }, (_command, args) => {
			if (args[0] === "display-message") return "%5\n";
			if (args[0] === "split-window") return "not-a-pane\n";
			return "";
		});
		expect(() =>
			client.launch({
				cwd: "/repo",
				title: "agent",
				channelDirectory: "/private/channel",
				channelToken: "token",
				environment: {},
				command: "pi",
				args: [],
			}),
		).toThrow(TmuxLaunchError);
	});
});
