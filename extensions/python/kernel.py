"""Persistent Python kernel for the pi-core `python` tool.

Protocol (one JSON object per line):
  requests on stdin:   {"id": int, "op": "exec", "code": str, "output": path}
                       {"id": int, "op": "names"}
  replies on stdout:   {"ready": true, "python": str}  (once, at startup)
                       {"id": int, "status": "ok" | "error" | "interrupted"}
                       {"id": int, "names": [str, ...]}

Everything a cell writes to fd 1 or 2 -- print(), tracebacks, and child
processes alike -- lands in that cell's output file, in order. The protocol
uses private duplicates of the original stdin/stdout, so cell code can never
corrupt it; between cells fd 0/1/2 point at /dev/null. Standard library only.
"""

import ast
import asyncio
import importlib
import importlib.util
import inspect
import io
import json
import linecache
import os
import shutil
import signal
import subprocess
import sys
import time
import traceback

KERNEL_FILE = os.path.abspath(__file__)

# Kept small on purpose: each name costs nothing until first use (lazy imports).
STDLIB_PRELUDE = """
lazy import os, sys, re, json, math, glob, shutil, subprocess, itertools, functools, collections, statistics, textwrap, hashlib, csv, time
lazy import datetime as dt
lazy from pathlib import Path
lazy from collections import Counter, defaultdict
"""
THIRD_PARTY_PRELUDE = {
    "numpy": "lazy import numpy as np",
    "pandas": "lazy import pandas as pd",
    "polars": "lazy import polars as pl",
    "duckdb": "lazy import duckdb",
    "yaml": "lazy import yaml",
    "httpx": "lazy import httpx",
}


class ShResult:
    """Result of sh(): exit code and merged stdout+stderr."""

    __slots__ = ("code", "out")

    def __init__(self, code, out):
        self.code = code
        self.out = out

    @property
    def ok(self):
        return self.code == 0

    def __repr__(self):
        out = self.out.rstrip("\n")
        return f"[exit {self.code}]\n{out}" if out else f"[exit {self.code}]"


def sh(command, timeout=None, cwd=None):
    """Run a shell command; return ShResult(code, out) with stderr merged into out."""
    done = subprocess.run(
        command,
        shell=True,
        cwd=cwd,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        timeout=timeout,
        text=True,
        errors="replace",
    )
    return ShResult(done.returncode, done.stdout)


def pip(*packages):
    """Install packages into this kernel's environment; usable immediately, no restart."""
    if not packages:
        raise ValueError("pip() needs at least one package name")
    uv = os.environ.get("PI_PYTHON_UV") or shutil.which("uv")
    if not uv:
        raise RuntimeError("uv is not available; cannot install packages")
    command = [uv, "pip", "install", "--quiet", "--python", sys.executable]
    exclude_newer = os.environ.get("PI_PYTHON_EXCLUDE_NEWER", "7 days")
    if exclude_newer:
        command += ["--exclude-newer", exclude_newer]
    done = subprocess.run(
        [*command, *packages],
        stdin=subprocess.DEVNULL,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        errors="replace",
    )
    importlib.invalidate_caches()
    if done.returncode != 0:
        raise RuntimeError(f"pip({', '.join(map(repr, packages))}) failed:\n{done.stdout.strip()}")
    print(f"installed: {' '.join(packages)}")


def process_group_members():
    """Live (non-zombie) processes in the kernel's group, excluding the kernel and
    the `ps` used to list them. None when the group cannot be listed."""
    pgrp, me = os.getpgrp(), os.getpid()
    try:
        ps = subprocess.Popen(
            ["ps", "-A", "-o", "pid=,pgid=,stat="],
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            text=True,
        )
        listing, _ = ps.communicate()
    except OSError:
        return None
    members = set()
    for line in listing.splitlines():
        fields = line.split()
        if len(fields) < 3 or fields[2].startswith("Z"):
            continue
        pid, pgid = int(fields[0]), int(fields[1])
        if pgid == pgrp and pid not in (me, ps.pid):
            members.add(pid)
    return members


def stop_process_group(term_grace=1.0, deadline_seconds=3.0):
    """After an interrupt, make sure no child work keeps running (e.g. `cmd & wait`
    background jobs ignore SIGINT). The whole group is re-listed on every round, so
    processes started during cleanup are caught too: SIGTERM first, SIGKILL after
    `term_grace`. Returns how many processes were signalled, or None if the group
    could not be emptied (or listed) by the deadline. Only acts when the kernel
    leads its own group."""
    if os.getpgrp() != os.getpid():
        return 0
    start = time.monotonic()
    signalled = set()
    while True:
        members = process_group_members()
        if members is None:
            return None
        if not members:
            return len(signalled)
        elapsed = time.monotonic() - start
        if elapsed > deadline_seconds:
            return None
        sig = signal.SIGTERM if elapsed < term_grace else signal.SIGKILL
        for pid in members:
            try:
                os.kill(pid, sig)
                signalled.add(pid)
            except OSError:
                pass
        time.sleep(0.1)


class Kernel:
    def __init__(self, proto_in, proto_out, devnull):
        self.proto_in = proto_in
        self.proto_out = proto_out
        self.devnull = devnull
        self.cell = 0
        self.executing = False
        self.session_cwd = os.getcwd()
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        self.ns = {"__name__": "__main__", "__builtins__": __builtins__, "sh": sh, "pip": pip}
        self.preload()
        self.baseline = set(self.ns)

    def preload(self):
        if sys.version_info < (3, 15):
            return  # `lazy import` is 3.15+; older interpreters just skip the prelude.
        source = STDLIB_PRELUDE + "\n".join(
            line for module, line in THIRD_PARTY_PRELUDE.items() if importlib.util.find_spec(module)
        )
        exec(compile(source, "<prelude>", "exec"), self.ns)

    def reply(self, message):
        self.proto_out.write(json.dumps(message) + "\n")
        self.proto_out.flush()

    def serve(self):
        signal.signal(signal.SIGINT, self.on_sigint)
        self.reply({"ready": True, "python": sys.version.split()[0]})
        for line in self.proto_in:
            request = json.loads(line)
            if request["op"] == "exec":
                status = self.exec_to_file(request["code"], request["output"], request.get("cwd"))
                self.reply({"id": request["id"], "status": status})
            elif request["op"] == "names":
                self.reply({"id": request["id"], "names": self.user_names()})

    def follow_session_cwd(self, cwd):
        """Follow the session directory when it changes; a cell's own os.chdir()
        holds until it moves again. Never silently run somewhere else."""
        if not cwd or cwd == self.session_cwd:
            return True
        try:
            os.chdir(cwd)
        except OSError as error:
            print(f"Session directory unavailable ({error.strerror}): {cwd}; the cell was not run.", file=sys.stderr)
            return False
        self.session_cwd = cwd
        return True

    def on_sigint(self, _signum, _frame):
        # Interrupt only running cell code; an idle kernel ignores stray signals.
        if self.executing:
            raise KeyboardInterrupt

    def user_names(self):
        return sorted(name for name in self.ns if name not in self.baseline and not name.startswith("_"))

    def exec_to_file(self, code, output_path, cwd):
        fd = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        os.dup2(fd, 1)
        os.dup2(fd, 2)
        os.close(fd)
        try:
            if not self.follow_session_cwd(cwd):
                return "error"
            return self.run_cell(code)
        finally:
            for stream in (sys.stdout, sys.stderr):
                try:
                    stream.flush()
                except Exception:
                    pass
            os.dup2(self.devnull, 1)
            os.dup2(self.devnull, 2)

    def run_cell(self, code):
        self.cell += 1
        filename = f"<cell {self.cell}>"
        # Register the source so tracebacks show the offending lines.
        linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
        flags = ast.PyCF_ALLOW_TOP_LEVEL_AWAIT
        try:
            tree = compile(code, filename, "exec", flags=ast.PyCF_ONLY_AST | flags)
            last = None
            if tree.body and isinstance(tree.body[-1], ast.Expr):
                last = ast.Expression(tree.body.pop().value)
            parts = [compile(tree, filename, "exec", flags=flags)]
            if last is not None:
                parts.append(compile(last, filename, "eval", flags=flags))
        except SyntaxError:
            traceback.print_exc(limit=0)
            return "error"
        self.executing = True
        try:
            value = None
            for part in parts:
                value = eval(part, self.ns)
                if part.co_flags & inspect.CO_COROUTINE:
                    value = self.loop.run_until_complete(value)
            if last is not None and value is not None:
                self.ns["_"] = value
                print(repr(value))  # still interruptible: a slow repr must not cost the kernel
            return "ok"
        except KeyboardInterrupt:
            self.executing = False
            # Async cleanup first: it may start processes, which the group sweep then catches.
            cancelled = self.cancel_pending_tasks()
            stopped = stop_process_group()
            # Work that survives cancellation would run during later cells: give up the kernel.
            if cancelled is None:
                self.reset_after_interrupt("asyncio tasks ignored cancellation")
            if stopped is None:
                self.reset_after_interrupt("child processes could not be stopped")
            notes = [f"{stopped} child process(es) stopped"] if stopped else []
            if cancelled:
                notes.append(f"{cancelled} pending asyncio task(s) cancelled")
            detail = " (" + ", ".join(notes) + ")" if notes else ""
            print(f"KeyboardInterrupt{detail}", file=sys.stderr)
            return "interrupted"
        except SystemExit as error:
            print(f"SystemExit({error.code!r}) ignored: the kernel keeps running", file=sys.stderr)
            return "error"
        except BaseException as error:
            self.print_user_traceback(error)
            return "error"
        finally:
            self.executing = False

    def reset_after_interrupt(self, reason):
        """Exit; the host reports lost state, and its group kill stops anything left."""
        print(f"KeyboardInterrupt: {reason}; resetting the kernel", file=sys.stderr)
        sys.stderr.flush()
        os._exit(70)

    def cancel_pending_tasks(self, deadline_seconds=2.0):
        """An interrupted cell must not resume later. Cancel every pending task, including
        tasks spawned during cleanup, until none remain. Returns the number cancelled, or
        None if some task still runs at the deadline."""
        cancelled = 0
        deadline = time.monotonic() + deadline_seconds
        while pending := [task for task in asyncio.all_tasks(self.loop) if not task.done()]:
            remaining = deadline - time.monotonic()
            if remaining <= 0:
                return None
            for task in pending:
                if not task.cancelling():
                    task.cancel()
                    cancelled += 1
            try:
                self.loop.run_until_complete(asyncio.wait(pending, timeout=remaining))
            except BaseException:
                pass
        return cancelled

    def print_user_traceback(self, error):
        tb = error.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename == KERNEL_FILE:
            tb = tb.tb_next
        traceback.print_exception(type(error), error, tb)


def main():
    # Private protocol channels, then point the standard fds at /dev/null so
    # cell code cannot read requests (input() gets EOF) or write replies.
    proto_in = os.fdopen(os.dup(0), "r", encoding="utf-8")
    proto_out = os.fdopen(os.dup(1), "w", encoding="utf-8")
    devnull = os.open(os.devnull, os.O_RDWR)
    for fd in (0, 1, 2):
        os.dup2(devnull, fd)
    sys.stdin = open(os.devnull, encoding="utf-8")
    # Unbuffered text streams keep Python writes ordered with child-process writes.
    sys.stdout = io.TextIOWrapper(
        io.FileIO(1, "w", closefd=False), encoding="utf-8", errors="backslashreplace", write_through=True
    )
    sys.stderr = io.TextIOWrapper(
        io.FileIO(2, "w", closefd=False), encoding="utf-8", errors="backslashreplace", write_through=True
    )
    try:
        Kernel(proto_in, proto_out, devnull).serve()
    finally:
        # The host closed the protocol (Pi exited or reset us): take down any
        # children we started too. The kernel leads its own process group.
        if os.getpgrp() == os.getpid():  # never signal a group we merely joined
            signal.signal(signal.SIGTERM, signal.SIG_DFL)
            os.killpg(os.getpgrp(), signal.SIGTERM)


if __name__ == "__main__":
    main()
