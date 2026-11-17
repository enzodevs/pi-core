"""Persistent Python kernel for the pi-core `python` tool.

Protocol (one JSON object per line):
  requests on stdin:   {"id": int, "op": "exec", "code": str, "output": path}
                       {"id": int, "op": "names"}
  replies on stdout:   {"ready": true, "python": str}  (once, at startup)
                       {"id": int, "status": "ok" | "error"}
                       {"id": int, "names": [str, ...]}

Everything a cell writes to fd 1 or 2 -- print(), tracebacks, and child
processes alike -- lands in that cell's output file, in order. The protocol
uses private duplicates of the original stdin/stdout, so cell code can never
corrupt it; between cells fd 0/1/2 point at /dev/null. Standard library only.

Interrupts and timeouts are owned by the host: it kills the kernel together with
every process it started and starts a fresh one. In-process cancellation cannot
reliably stop threads, loop callbacks or code that swallows KeyboardInterrupt.
"""

import ast
import asyncio
import collections
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


SH_CAPTURE_BYTES = 4 * 1024 * 1024  # sh() keeps this much of the start and of the end
CELL_SOURCE_BUDGET = 1024 * 1024  # characters of cell source kept for tracebacks


class ShResult:
    """Result of sh(): exit code, merged stdout+stderr, and bytes dropped from the middle."""

    __slots__ = ("code", "out", "omitted")

    def __init__(self, code, out, omitted=0):
        self.code = code
        self.out = out
        self.omitted = omitted

    @property
    def ok(self):
        return self.code == 0

    def __repr__(self):
        out = self.out.rstrip("\n")
        return f"[exit {self.code}]\n{out}" if out else f"[exit {self.code}]"


def sh(command, cwd=None):
    """Run a shell command; return ShResult(code, out) with stderr merged into out.
    Output beyond SH_CAPTURE_BYTES keeps its start and end, with an omission marker."""
    half = SH_CAPTURE_BYTES // 2
    head, tail, total = bytearray(), bytearray(), 0
    proc = subprocess.Popen(
        command, shell=True, cwd=cwd, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT
    )
    with proc.stdout:
        while chunk := proc.stdout.read1(65536):
            total += len(chunk)
            room = half - len(head)
            if room > 0:
                head += chunk[:room]
                chunk = chunk[room:]
            if chunk:
                tail += chunk
                if len(tail) > half:
                    del tail[: len(tail) - half]
    code = proc.wait()
    omitted = total - len(head) - len(tail)
    out = head.decode(errors="replace")
    if omitted:
        out += f"\n[... {omitted} bytes omitted by sh(); redirect to a file to keep everything ...]\n"
    return ShResult(code, out + tail.decode(errors="replace"), omitted)


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


class Kernel:
    def __init__(self, proto_in, proto_out, devnull):
        self.proto_in = proto_in
        self.proto_out = proto_out
        self.devnull = devnull
        self.cell = 0
        self.sources = collections.OrderedDict()  # cell filename -> source length
        self.source_chars = 0
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
        self.remember_source(filename, code)
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
        try:
            value = None
            for part in parts:
                value = eval(part, self.ns)
                if part.co_flags & inspect.CO_COROUTINE:
                    value = self.loop.run_until_complete(value)
            if last is not None and value is not None:
                self.ns["_"] = value
                print(repr(value))
            return "ok"
        except SystemExit as error:
            print(f"SystemExit({error.code!r}) ignored: the kernel keeps running", file=sys.stderr)
            return "error"
        except BaseException as error:
            self.print_user_traceback(error)
            return "error"

    def remember_source(self, filename, code):
        """Register a cell's source so tracebacks show its lines, within a budget:
        the oldest cells lose their source lines first (line numbers remain)."""
        linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
        self.sources[filename] = len(code)
        self.source_chars += len(code)
        while self.source_chars > CELL_SOURCE_BUDGET and len(self.sources) > 1:
            old, size = self.sources.popitem(last=False)
            linecache.cache.pop(old, None)
            self.source_chars -= size

    def print_user_traceback(self, error):
        tb = error.__traceback__
        while tb is not None and tb.tb_frame.f_code.co_filename == KERNEL_FILE:
            tb = tb.tb_next
        traceback.print_exception(type(error), error, tb)


def become_subreaper():
    """Linux: adopt orphaned descendants (double-forked daemons, setsid children whose
    parent exited), so the host can still find and stop them through the kernel."""
    if not sys.platform.startswith("linux"):
        return
    try:
        import ctypes

        ctypes.CDLL(None, use_errno=True).prctl(36, 1, 0, 0, 0)  # PR_SET_CHILD_SUBREAPER
    except (OSError, AttributeError):
        pass


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
    become_subreaper()
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
