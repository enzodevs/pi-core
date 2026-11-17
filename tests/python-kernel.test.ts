import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	realpathSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
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

	// Interrupted work writes pid files to the cell directory: variables die with the kernel.
	const pidFrom = async (dir: string, name: string) =>
		Number((await readFile(join(dir, name), "utf8").catch(() => "0")).trim());
	const abortAfter = (ms: number) => {
		const controller = new AbortController();
		setTimeout(() => controller.abort(), ms);
		return controller.signal;
	};

	it("resets the kernel on abort and says that variables are gone", async () => {
		const kernel = create();
		await kernel.exec("kept = 'yes'");
		const result = await kernel.exec("while True:\n    pass", undefined, abortAfter(200));
		expect(result.status).toBe("interrupted");
		expect(result.text).toContain("variables are gone");
		const next = await kernel.exec("'kept' in globals()");
		expect(next).toMatchObject({ status: "ok", text: "False" });
	});

	it("stops work even when the cell swallows KeyboardInterrupt or keeps threads and callbacks", async () => {
		const dir = temp();
		const kernel = create(400);
		const swallowed = await kernel.exec(
			[
				"import subprocess, time",
				"child = subprocess.Popen(['sh', '-c', 'trap \"\" INT TERM; exec sleep 30'])",
				"open('child.pid', 'w').write(str(child.pid))",
				"try:",
				"    time.sleep(10)",
				"except KeyboardInterrupt:",
				"    pass",
			].join("\n"),
			dir,
		);
		expect(swallowed.status).toBe("timeout");
		const child = await pidFrom(dir, "child.pid");
		expect(child).toBeGreaterThan(0);
		expect(await eventually(() => !alive(child))).toBe(true);

		const late = await kernel.exec(
			[
				"import asyncio, time",
				"def work():",
				"    time.sleep(0.6)",
				"    open('thread-ran', 'w').close()",
				"async def main():",
				"    asyncio.get_running_loop().call_later(0.6, lambda: open('callback-ran', 'w').close())",
				"    await asyncio.to_thread(work)",
				"await main()",
			].join("\n"),
			dir,
		);
		expect(late.status).toBe("timeout");
		await new Promise((resolve) => setTimeout(resolve, 900));
		expect(existsSync(join(dir, "thread-ran"))).toBe(false);
		expect(existsSync(join(dir, "callback-ran"))).toBe(false);
	});

	it("stops shell background jobs in the kernel's process group on timeout", async () => {
		const dir = temp();
		const kernel = create(500);
		const result = await kernel.exec("sh('sleep 30 & echo $! > job.pid; wait')", dir);
		expect(result.status).toBe("timeout");
		expect(result.text).toContain("process group were stopped");
		const job = await pidFrom(dir, "job.pid");
		expect(job).toBeGreaterThan(0);
		expect(await eventually(() => !alive(job))).toBe(true);
	});

	it("never runs a cell whose call was aborted while the kernel was starting", async () => {
		const dir = temp();
		const slow = join(temp(), "slow-python");
		writeFileSync(slow, `#!/bin/sh\nsleep 0.4\nexec "${python}" "$@"\n`, { mode: 0o755 });
		const kernel = new PythonKernel({ python: slow, cwd: dir, outputDir: temp() });
		kernels.push(kernel);
		const result = await kernel.exec("open('ran', 'w').close()", dir, abortAfter(100));
		expect(result).toMatchObject({ status: "interrupted", text: "[cancelled before running]" });
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(existsSync(join(dir, "ran"))).toBe(false);
		expect((await kernel.exec("1 + 1", dir)).text).toBe("2");
	});

	it("stops the kernel's children on dispose and after a crash", async () => {
		const kernel = create();
		const orphan = Number(
			(await kernel.exec("import subprocess\nsubprocess.Popen(['sleep', '30']).pid")).text,
		);
		expect((await kernel.exec("import os\nos._exit(1)")).status).toBe("crashed");
		expect(await eventually(() => !alive(orphan))).toBe(true);

		const restarted = await kernel.exec("import subprocess\nsubprocess.Popen(['sleep', '30']).pid");
		expect(restarted.text).toContain("[new kernel: variables from the previous kernel are gone]");
		const background = Number(restarted.text.split("\n").at(-1));
		expect(alive(background)).toBe(true);
		kernel.dispose();
		expect(await eventually(() => !alive(background))).toBe(true);
	});

	it("fails the cell instead of running in the wrong directory when the session directory is gone", async () => {
		const kernel = create();
		const result = await kernel.exec("open('should-not-exist', 'w').close()", "/nonexistent/pi-python-dir");
		expect(result.status).toBe("error");
		expect(result.text).toContain("Session directory unavailable");
		expect(result.text).toContain("the cell was not run");
		expect((await kernel.exec("import os\nos.path.exists('should-not-exist')")).text).toBe("False");
	});

	it("restarts in the current session directory after the original one is removed", async () => {
		const original = temp();
		const moved = temp();
		const kernel = new PythonKernel({ python, cwd: original, outputDir: temp() });
		kernels.push(kernel);
		await kernel.exec("1", original);
		await kernel.exec("1", moved);
		rmSync(original, { recursive: true, force: true });
		expect((await kernel.exec("import os\nos._exit(1)", moved)).status).toBe("crashed");
		const fresh = await kernel.exec("import os\nos.getcwd()", moved);
		expect(fresh.status).toBe("ok");
		expect(fresh.text).toContain(moved);
	});

	it("keeps a bounded number of bytes of cell source, never one oversized cell", async () => {
		const kernel = create();
		const comment = `# ${"x".repeat(600_000)}\n`;
		for (let cell = 0; cell < 4; cell++) await kernel.exec(`${comment}value = ${cell}`);
		const measure =
			"import linecache\nsum(len(''.join(entry[2]).encode()) for name, entry in linecache.cache.items() if name.startswith('<cell'))";
		expect(Number((await kernel.exec(measure)).text)).toBeLessThanOrEqual(1024 * 1024);
		const huge = await kernel.exec(`# ${"😀".repeat(300_000)}\n${measure}`);
		expect(Number(huge.text)).toBeLessThanOrEqual(1024 * 1024);
		const failed = await kernel.exec("raise ValueError('still shows source')");
		expect(failed.text).toContain("raise ValueError");
	});

	it("re-enters a session directory that was removed and recreated", async () => {
		const dir = temp();
		const kernel = create();
		await kernel.exec("1", dir);
		rmSync(dir, { recursive: true });
		mkdirSync(dir);
		const result = await kernel.exec("import os\nopen('here', 'w').close()\nos.getcwd()", dir);
		expect(result).toMatchObject({ status: "ok", text: `'${dir}'` });
		expect(existsSync(join(dir, "here"))).toBe(true);
	});

	it("stops a running cell whose output passes the limit and saves exactly its start", async () => {
		const kernel = create();
		const burst = await kernel.exec(
			"import os\nchunk = b'x' * 1048576\nfor _ in range(80):\n    os.write(1, chunk)",
		);
		expect(burst.status).toBe("error");
		expect(burst.text).toMatch(/output passed 64\.0MB/);
		expect(burst.text).toContain("variables are gone");
		expect(statSync(burst.fullOutputPath as string).size).toBe(64 * 1024 * 1024);

		const flood = await kernel.exec("import os\nchunk = b'x' * 1048576\nwhile True:\n    os.write(1, chunk)");
		expect(flood.status).toBe("error");
		expect(statSync(flood.fullOutputPath as string).size).toBe(64 * 1024 * 1024);
	});

	it("discards output that background processes write after their cell ended", async () => {
		const kernel = create();
		const cell = await kernel.exec(
			[
				"import subprocess, sys",
				"late = subprocess.Popen([sys.executable, '-c', \"import time, os; time.sleep(0.3); os.write(1, b'z' * 20_000_000)\"])",
				"print('x' * 40000)",
			].join("\n"),
		);
		expect(cell.fullOutputPath).toBeDefined();
		const saved = statSync(cell.fullOutputPath as string).size;
		expect((await kernel.exec("late.wait()")).text).toBe("0");
		expect(statSync(cell.fullOutputPath as string).size).toBe(saved);
	});

	it("keeps captures of running cells away from saved-output pruning", async () => {
		const outputDir = temp();
		const kernel = new PythonKernel({ python, cwd: temp(), outputDir });
		kernels.push(kernel);
		const running = kernel.exec("import time\nprint('started', flush=True)\ntime.sleep(0.6)\n'done'");
		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(readdirSync(outputDir).filter((name) => statSync(join(outputDir, name)).isFile())).toEqual([]);
		expect(readdirSync(join(outputDir, "active"))).toHaveLength(1);
		expect((await running).text).toBe("started\n'done'");
	});

	it("bounds sh() capture and keeps valid UTF-8 intact", async () => {
		const kernel = create();
		const captured = await kernel.exec(
			"r = sh(\"head -c 10000000 /dev/zero | tr '\\\\0' x\")\n(r.code, len(r.out) < 4_300_000, r.omitted, 'bytes omitted by sh()' in r.out)",
		);
		expect(captured.text).toBe("(0, True, 5805696, True)");
		const euro = await kernel.exec(
			"import shlex, sys\nr = sh(shlex.quote(sys.executable) + ' -c ' + shlex.quote(\"import sys; sys.stdout.write('€' * 800000)\"))\n(r.omitted, len(r.out), r.out.count('\\ufffd'))",
		);
		expect(euro.text).toBe("(0, 800000, 0)");
		const cut = await kernel.exec(
			"r = sh(shlex.quote(sys.executable) + ' -c ' + shlex.quote(\"import sys; sys.stdout.write('€' * 2000000)\"))\n(r.omitted > 0, r.out.count('\\ufffd'))",
		);
		expect(cut.text).toBe("(True, 0)");
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
