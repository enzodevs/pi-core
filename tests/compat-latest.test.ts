import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Exercise the real script without network access or recursive copies of this repository.
async function runCompatibility(failAt = "") {
	const root = await mkdtemp(join(tmpdir(), "pi-core-compat-test-"));
	try {
		const project = join(root, "project");
		const bin = join(root, "bin");
		const log = join(root, "commands.jsonl");
		await mkdir(join(project, "scripts"), { recursive: true });
		await mkdir(bin);
		await copyFile(resolve("scripts/compat-latest.mjs"), join(project, "scripts/compat-latest.mjs"));
		await writeFile(join(project, "package.json"), JSON.stringify({ devDependencies: {} }));
		const npm = join(bin, "npm");
		await writeFile(
			npm,
			`#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.appendFileSync(process.env.COMPAT_TEST_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
if (args.join(" ") === process.env.COMPAT_TEST_FAIL) process.exitCode = 7;
`,
		);
		await chmod(npm, 0o755);
		const result = spawnSync(process.execPath, [join(project, "scripts/compat-latest.mjs")], {
			encoding: "utf8",
			env: {
				...process.env,
				PATH: `${bin}${delimiter}${process.env.PATH}`,
				PI_CORE_KEEP_COMPAT_TEMP: "0",
				COMPAT_TEST_LOG: log,
				COMPAT_TEST_FAIL: failAt,
			},
			timeout: 30_000,
		});
		if (result.error) throw result.error;
		const calls = (await readFile(log, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line) as { args: string[]; cwd: string });
		return {
			status: result.status,
			commands: calls.map(({ args }) => args.join(" ")),
			cleaned: calls.every(({ cwd }) => !existsSync(cwd)),
		};
	} finally {
		await rm(root, { recursive: true, force: true });
	}
}

describe("latest Pi compatibility gate", () => {
	it("includes package installation/loading after typecheck, tests, and packing", async () => {
		const result = await runCompatibility();
		expect(result.status).toBe(0);
		expect(result.commands).toEqual([
			"install --ignore-scripts --no-audit --no-fund",
			"run typecheck",
			"test",
			"pack --dry-run",
			"run compat:package",
		]);
		expect(result.cleaned).toBe(true);
	});

	it("stops at a failed typecheck, preserves failure status, and cleans the workspace", async () => {
		const result = await runCompatibility("run typecheck");
		expect(result.status).toBe(7);
		expect(result.commands).toHaveLength(2);
		expect(result.cleaned).toBe(true);
	});

	it("propagates package installation or loader failures", async () => {
		const result = await runCompatibility("run compat:package");
		expect(result.status).toBe(7);
		expect(result.commands.at(-1)).toBe("run compat:package");
		expect(result.cleaned).toBe(true);
	});
});
