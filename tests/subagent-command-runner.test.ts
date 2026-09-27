import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { expect, it, vi } from "vitest";

const spawn = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ spawn }));

import { defaultCommandRunner } from "../extensions/subagent/worktrunk.ts";

it("waits for stream closure before interpreting command output", async () => {
	const child = Object.assign(new EventEmitter(), {
		stdout: new PassThrough(),
		stderr: new PassThrough(),
		kill: vi.fn(),
	});
	spawn.mockReturnValue(child);
	const result = defaultCommandRunner("git", ["rev-parse", "HEAD"], "/tmp");
	child.emit("exit", 0, null);
	child.stdout.write("final-commit-sha\n");
	child.stderr.write("late diagnostic\n");
	child.emit("close", 0, null);
	await expect(result).resolves.toEqual({ stdout: "final-commit-sha\n", stderr: "late diagnostic\n" });
});
