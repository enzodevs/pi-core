import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import backgroundAgents from "../extensions/subagent/index.ts";
import * as worktrees from "../extensions/subagent/worktree-reaper.ts";

afterEach(() => vi.restoreAllMocks());

function commandFixture(approved: boolean, hasUI = true) {
	let handler: ((args: string, ctx: ExtensionCommandContext) => Promise<void>) | undefined;
	const pi = {
		on: vi.fn(),
		registerTool: vi.fn(),
		registerCommand: (name: string, options: { handler: typeof handler }) => {
			if (name === "worktrees-clean") handler = options.handler;
		},
	};
	const paths = ["/repo.pi-agent-worker-abcd1234"];
	const discover = vi.spyOn(worktrees, "discoverLegacyWorktrees").mockResolvedValue(paths);
	const adopt = vi.spyOn(worktrees.WorktreeLedger.prototype, "adopt").mockResolvedValue();
	const reap = vi
		.spyOn(worktrees, "reapIntegratedWorktrees")
		.mockResolvedValue({ removed: [], retained: [] });
	const ui = { confirm: vi.fn().mockResolvedValue(approved), notify: vi.fn() };
	const ctx = { cwd: "/repo", hasUI, ui } as unknown as ExtensionCommandContext;
	backgroundAgents(pi as unknown as ExtensionAPI);
	if (!handler) throw new Error("worktrees-clean was not registered");
	return { handler, ctx, ui, paths, discover, adopt, reap };
}

describe("worktree cleanup command", () => {
	it("does not adopt or remove anything when confirmation is declined", async () => {
		const f = commandFixture(false);
		await f.handler("--adopt", f.ctx);
		expect(f.ui.confirm).toHaveBeenCalledOnce();
		expect(f.adopt).not.toHaveBeenCalled();
		expect(f.reap).not.toHaveBeenCalled();
	});

	it("adopts the confirmed paths before reaping", async () => {
		const f = commandFixture(true);
		await f.handler("--adopt", f.ctx);
		expect(f.adopt).toHaveBeenCalledWith(f.paths);
		expect(f.reap).toHaveBeenCalledOnce();
		expect(f.adopt.mock.invocationCallOrder[0]).toBeLessThan(f.reap.mock.invocationCallOrder[0] ?? 0);
	});

	it("requires interactive confirmation for legacy adoption", async () => {
		const f = commandFixture(true, false);
		await f.handler("--adopt", f.ctx);
		expect(f.discover).not.toHaveBeenCalled();
		expect(f.adopt).not.toHaveBeenCalled();
		expect(f.reap).not.toHaveBeenCalled();
		expect(f.ui.notify).toHaveBeenCalledWith(expect.stringContaining("interactive confirmation"), "warning");
	});

	it("does not discover or adopt legacy worktrees during an ordinary cleanup", async () => {
		const f = commandFixture(false);
		await f.handler("", f.ctx);
		expect(f.discover).not.toHaveBeenCalled();
		expect(f.adopt).not.toHaveBeenCalled();
		expect(f.reap).toHaveBeenCalledOnce();
	});
});
