import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { formatNamesNotice } from "../extensions/python/index.js";
import { MAX_OUTPUT_BYTES, PythonKernel } from "../extensions/python/kernel-client.js";

// The kernel is stdlib-only and runs on 3.11+; PI_CORE_PYTHON selects another interpreter (e.g. the 3.15 venv).
const python = process.env.PI_CORE_PYTHON || "python3";
const available = spawnSync(python, ["-c", "import sys; assert sys.version_info >= (3, 11)"]).status === 0;

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function eventually(check: () => boolean, ms = 3_000): Promise<boolean> {
	const end = Date.now() + ms;
	while (Date.now() < end) {
		if (check()) return true;
		await new Promise((resolve) => setTimeout(resolve, 50));
	}
	return check();
}

describe.skipIf(!available)("python kernel", () => {
	const kernels: PythonKernel[] = [];
	const dirs: string[] = [];
	const temp = () => {
		const dir = realpathSync(mkdtempSync(join(tmpdir(), "pi-python-test-")));
		dirs.push(dir);
		return dir;
	};
	const create = (cellTimeoutMs?: number) => {
		const kernel = new PythonKernel({ python, cwd: temp(), outputDir: temp(), cellTimeoutMs });
		kernels.push(kernel);
		return kernel;
	};
	afterEach(() => {
		for (const kernel of kernels.splice(0)) kernel.dispose();
		for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	});

	it("keeps state across cells and captures Python and child-process output in order", async () => {
		const kernel = create();
		expect(await kernel.exec("rows = list(range(5))\nprint('first')")).toMatchObject({
			status: "ok",
			text: "first",
		});
		const result = await kernel.exec("import os\nos.system('echo from-child')\nprint('after')\nsum(rows)");
		expect(result).toMatchObject({ status: "ok", text: "from-child\nafter\n10" });
		expect(await kernel.exec("total = 1")).toMatchObject({ status: "ok", text: "(no output)" });
		expect(await kernel.names()).toEqual(expect.arrayContaining(["rows", "total"]));
	});

	it("reports exceptions with the cell source and keeps the kernel alive", async () => {
		const kernel = create();
		await kernel.exec("x = 2");
		const failed = await kernel.exec("y = x\nraise ValueError('bad value')");
		expect(failed.status).toBe("error");
		expect(failed.text).toContain("<cell 2>");
		expect(failed.text).toContain("ValueError: bad value");
		expect(failed.text).not.toContain("kernel.py");
		expect(await kernel.exec("x + y")).toMatchObject({ status: "ok", text: "4" });
	});

	it("never blocks on stdin and ignores exit()", async () => {
		const kernel = create();
		expect((await kernel.exec("input()")).text).toContain("EOFError");
		expect((await kernel.exec("raise SystemExit(3)")).text).toContain("SystemExit(3) ignored");
		expect(await kernel.exec("'still here'")).toMatchObject({ status: "ok", text: "'still here'" });
	});

	it("interrupts a running cell on abort and keeps earlier state", async () => {
		const kernel = create();
		await kernel.exec("kept = 'yes'");
		const controller = new AbortController();
		const running = kernel.exec("while True:\n    pass", undefined, controller.signal);
		setTimeout(() => controller.abort(), 200);
		const result = await running;
		expect(result.status).toBe("interrupted");
		expect(result.text).toContain("[interrupted; kernel state kept]");
		expect(await kernel.exec("kept")).toMatchObject({ status: "ok", text: "'yes'" });
	});

	it("stops the cell's child processes on interrupt and on dispose", async () => {
		const kernel = create(400);
		const timedOut = await kernel.exec(
			"import subprocess\nchild = subprocess.Popen(['sleep', '30'])\nchild_pid = child.pid\nchild.wait()",
		);
		expect(timedOut.status).toBe("timeout");
		const waited = Number((await kernel.exec("child_pid")).text);
		expect(await eventually(() => !alive(waited))).toBe(true);

		const background = Number((await kernel.exec("subprocess.Popen(['sleep', '30']).pid")).text);
		expect(alive(background)).toBe(true);
		kernel.dispose();
		expect(await eventually(() => !alive(background))).toBe(true);
	});

	it("stops background shell jobs that ignore SIGINT and children left by a crashed kernel", async () => {
		const kernel = create(500);
		const interrupted = await kernel.exec(
			"import os\nopen('job.pid', 'w').close()\nsh('sleep 30 & echo $! > job.pid; wait')",
		);
		expect(interrupted.status).toBe("timeout");
		expect(interrupted.text).toMatch(/child process\(es\) stopped/);
		const job = Number((await kernel.exec("open('job.pid').read().strip()")).text.replaceAll("'", ""));
		expect(job).toBeGreaterThan(0);
		expect(await eventually(() => !alive(job))).toBe(true);

		const orphan = Number(
			(await kernel.exec("import subprocess\nsubprocess.Popen(['sleep', '30']).pid")).text,
		);
		expect((await kernel.exec("os._exit(1)")).status).toBe("crashed");
		expect(await eventually(() => !alive(orphan))).toBe(true);
	});

	it("catches processes started during cleanup and counts only real children", async () => {
		const kernel = create();
		const fromFinally = new AbortController();
		setTimeout(() => fromFinally.abort(), 300);
		const cleanup = await kernel.exec(
			[
				"import asyncio, subprocess",
				"late = []",
				"async def main():",
				"    try:",
				"        await asyncio.sleep(10)",
				"    finally:",
				"        late.append(subprocess.Popen(['sleep', '30']).pid)",
				"await main()",
			].join("\n"),
			undefined,
			fromFinally.signal,
		);
		expect(cleanup.status).toBe("interrupted");
		const late = Number((await kernel.exec("late[0]")).text);
		expect(await eventually(() => !alive(late))).toBe(true);

		const respawning = new AbortController();
		setTimeout(() => respawning.abort(), 400);
		const respawned = await kernel.exec(
			// Popen().wait() does not kill its child on interrupt (subprocess.run would), so the
			// TERM trap really runs and starts a replacement mid-cleanup.
			"subprocess.Popen(['sh', '-c', \"trap 'sleep 30 & echo $! > replacement.pid; exit 0' TERM; trap '' INT; while true; do sleep 0.1; done\"]).wait()",
			undefined,
			respawning.signal,
		);
		expect(respawned.status).toBe("interrupted");
		const replacement = Number(
			(await kernel.exec("open('replacement.pid').read().strip()")).text.replaceAll("'", ""),
		);
		expect(replacement).toBeGreaterThan(0);
		expect(await eventually(() => !alive(replacement))).toBe(true);

		const asyncOnly = new AbortController();
		setTimeout(() => asyncOnly.abort(), 200);
		const quiet = await kernel.exec("await asyncio.sleep(10)", undefined, asyncOnly.signal);
		expect(quiet.text).not.toContain("child process");
	});

	it("resets the kernel when asyncio work refuses cancellation, and cancels tasks spawned during cleanup", async () => {
		const kernel = create();
		const spawned = new AbortController();
		setTimeout(() => spawned.abort(), 300);
		const cleaned = await kernel.exec(
			[
				"import asyncio",
				"hits = []",
				"async def later():",
				"    await asyncio.sleep(0.5)",
				"    hits.append('spawned task resumed')",
				"async def main():",
				"    try:",
				"        await asyncio.sleep(10)",
				"    finally:",
				"        asyncio.get_running_loop().create_task(later())",
				"await main()",
			].join("\n"),
			undefined,
			spawned.signal,
		);
		expect(cleaned.status).toBe("interrupted");
		expect(await kernel.exec("await asyncio.sleep(0.8)\nhits")).toMatchObject({ status: "ok", text: "[]" });

		const stubborn = new AbortController();
		setTimeout(() => stubborn.abort(), 300);
		const reset = await kernel.exec(
			[
				"async def stubborn():",
				"    try:",
				"        await asyncio.sleep(10)",
				"    except asyncio.CancelledError:",
				"        await asyncio.sleep(5)",
				"await stubborn()",
			].join("\n"),
			undefined,
			stubborn.signal,
		);
		expect(reset.status).toBe("crashed");
		expect(reset.text).toContain("asyncio tasks ignored cancellation; resetting the kernel");
		expect((await kernel.exec("'hits' in globals()")).text).toContain("[new kernel");
	});

	it("fails the cell instead of running in the wrong directory when the session directory is gone", async () => {
		const kernel = create();
		const result = await kernel.exec("open('should-not-exist', 'w').close()", "/nonexistent/pi-python-dir");
		expect(result.status).toBe("error");
		expect(result.text).toContain("Session directory unavailable");
		expect(result.text).toContain("the cell was not run");
		expect((await kernel.exec("import os\nos.path.exists('should-not-exist')")).text).toBe("False");
	});

	it("cancels pending asyncio work so an interrupted cell never resumes later", async () => {
		const kernel = create();
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		const interrupted = await kernel.exec(
			"import asyncio\nhits = []\nasync def late():\n    await asyncio.sleep(0.6)\n    hits.append('resumed')\nawait late()",
			undefined,
			controller.signal,
		);
		expect(interrupted.status).toBe("interrupted");
		expect(interrupted.text).toContain("pending asyncio task(s) cancelled");
		expect(await kernel.exec("await asyncio.sleep(0.8)\nhits")).toMatchObject({ status: "ok", text: "[]" });
	});

	it("keeps a slow result repr interruptible instead of killing the kernel", async () => {
		const kernel = create(300);
		await kernel.exec(
			"import time\nclass Slow:\n    def __repr__(self):\n        time.sleep(30)\n        return 'slow'",
		);
		await kernel.exec("kept = 1");
		expect((await kernel.exec("Slow()")).status).toBe("timeout");
		expect(await kernel.exec("kept")).toMatchObject({ status: "ok", text: "1" });
	});

	it("bounds huge output to its start and end and keeps the full text across dispose", async () => {
		const kernel = create();
		const result = await kernel.exec("for i in range(20000):\n    print(f'line {i:05d}')");
		expect(result.status).toBe("ok");
		expect(Buffer.byteLength(result.text)).toBeLessThan(MAX_OUTPUT_BYTES + 500);
		expect(result.text).toContain("line 00000");
		expect(result.text).toContain("line 19999");
		expect(result.text).toMatch(/omitted/);
		expect(result.text).toMatch(/\[output truncated: .*full output: /);
		kernel.dispose();
		const full = await readFile(result.fullOutputPath ?? "", "utf8");
		expect(full.split("\n")).toHaveLength(20001);
	});

	it("bounds many short lines and keeps previews of single long lines", async () => {
		const kernel = create();
		const lines = await kernel.exec("print('\\n'.join(str(i) for i in range(1000)))");
		expect(lines.text).toMatch(/^0\n1\n/);
		expect(lines.text).toContain("lines omitted");
		expect(lines.text).toMatch(/\n999\n\[output truncated/);
		const longLine = await kernel.exec("print('x' * 40000)");
		expect(longLine.text).not.toContain("(no output)");
		expect(longLine.text).toMatch(/x{1000}/);
		const multibyte = await kernel.exec("print('é' * 30000)");
		expect(multibyte.text).toMatch(/é{1000}/);
		const emoji = await kernel.exec("print('🙂' * 12000)");
		expect(emoji.text).toMatch(/(🙂){1000}/u);
		expect(emoji.text).not.toContain("�");
	});

	it("deletes the output of untruncated cells", async () => {
		const kernel = create();
		const small = await kernel.exec("print('small')");
		expect(small.fullOutputPath).toBeUndefined();
		const big = await kernel.exec("print('x' * 100_000)");
		expect(existsSync(big.fullOutputPath ?? "")).toBe(true);
	});

	it("follows the session directory but keeps a cell's own chdir until it moves", async () => {
		const kernel = create();
		const [first, second, own] = [temp(), temp(), temp()];
		expect((await kernel.exec("import os\nos.getcwd()", first)).text).toBe(`'${first}'`);
		expect((await kernel.exec("os.getcwd()", second)).text).toBe(`'${second}'`);
		await kernel.exec(`os.chdir(${JSON.stringify(own)})`, second);
		expect((await kernel.exec("os.getcwd()", second)).text).toBe(`'${own}'`);
		expect((await kernel.exec("sh('pwd').out.strip()", first)).text).toBe(`'${first}'`);
	});

	it("reports a dead kernel and starts a fresh one that says state was lost", async () => {
		const kernel = create();
		await kernel.exec("data = [1, 2, 3]");
		const crashed = await kernel.exec("import os\nos._exit(1)");
		expect(crashed.status).toBe("crashed");
		expect(crashed.text).toContain("variables are lost");
		const next = await kernel.exec("'data' in globals()");
		expect(next).toMatchObject({ status: "ok" });
		expect(next.text).toBe("[new kernel: variables from the previous kernel are gone]\nFalse");
	});

	it("starts clean after reset without a lost-state note", async () => {
		const kernel = create();
		await kernel.exec("a = 1");
		kernel.reset();
		expect(await kernel.exec("'a' in globals()")).toMatchObject({ status: "ok", text: "False" });
	});

	it("supports top-level await", async () => {
		const kernel = create();
		expect(await kernel.exec("import asyncio\nawait asyncio.sleep(0.01)\n'done'")).toMatchObject({
			status: "ok",
			text: "'done'",
		});
	});
});

describe("python compaction notice", () => {
	it("is omitted for an empty namespace and bounds names by bytes", () => {
		expect(formatNamesNotice([])).toBeUndefined();
		const notice = formatNamesNotice(Array.from({ length: 500 }, (_, i) => `variable_${i}`)) ?? "";
		expect(Buffer.byteLength(notice)).toBeLessThanOrEqual(2_000 + 20);
		expect(notice).toMatch(/\(\+\d+ more\)$/);
		expect(formatNamesNotice(["x".repeat(100_000), "kept"])).toMatch(/: kept \(\+1 more\)$/);
	});
});
