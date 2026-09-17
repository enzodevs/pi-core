import { describe, expect, it } from "vitest";
import {
	type ContextSnapshot,
	parseContextView,
	renderContextView,
} from "../extensions/context-inspector/core.js";

const snapshot: ContextSnapshot = {
	usage: { tokens: 1_250, contextWindow: 10_000, percent: 12.5 },
	systemPrompt: "SYSTEM BODY",
	options: {
		cwd: "/work",
		selectedTools: ["read"],
		toolSnippets: { read: "Read a file" },
		contextFiles: [{ path: "/work/AGENTS.md", content: "RULES" }],
		skills: [
			{
				name: "review",
				description: "Review code",
				filePath: "/skills/review/SKILL.md",
				baseDir: "/skills/review",
				sourceInfo: {
					path: "/skills/review/SKILL.md",
					source: "test",
					scope: "temporary",
					origin: "top-level",
				},
				disableModelInvocation: false,
			},
		],
	},
	messages: [{ role: "user", content: "hello" }],
	payload: { input: ["serialized"] },
	payloadCapturedAt: "2026-09-17T20:00:00.000Z",
	sessionId: "session-1",
	sessionFile: "/sessions/1.jsonl",
	model: "openai/gpt",
};

describe("context inspector", () => {
	it("parses only supported views and defaults to summary", () => {
		expect(parseContextView("")).toBe("summary");
		expect(parseContextView(" PAYLOAD ")).toBe("payload");
		expect(parseContextView("unknown")).toBeUndefined();
	});

	it("reports status and exactness boundaries", () => {
		const output = renderContextView("summary", snapshot);
		expect(output).toContain("1,250 / 10,000 tokens (12.5%)");
		expect(output).toContain("context files: 1");
		expect(output).toContain("extensions loaded after this one may still rewrite payload");
	});

	it("renders exact prompt inputs and captured payload on demand", () => {
		expect(renderContextView("system", snapshot)).toBe("SYSTEM BODY");
		expect(renderContextView("files", snapshot)).toContain("/work/AGENTS.md\n  5 B\nRULES");
		expect(renderContextView("skills", snapshot)).toContain("file: /skills/review/SKILL.md");
		expect(renderContextView("tools", snapshot)).toContain('"read": "Read a file"');
		expect(renderContextView("payload", snapshot)).toContain('"serialized"');
	});

	it("explains when no provider payload exists yet", () => {
		expect(renderContextView("payload", { ...snapshot, payload: undefined })).toContain(
			"No provider request captured yet",
		);
	});
});
