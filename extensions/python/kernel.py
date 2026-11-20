"""Persistent Python kernel for the pi-core `python` tool.

Protocol (one JSON object per line):
  requests on stdin:   {"id": int, "op": "exec", "code": str, "output": path}
                       {"id": int, "op": "names"}
  replies on stdout:   {"ready": true, "python": str}  (once, at startup)
                       {"id": int, "status": "ok" | "error", "overflow": bool}
                       {"overflow": true}  (while a cell runs: its output passed the limit)
                       {"id": int, "names": [str, ...]}

Everything a cell writes to fd 1 or 2 -- print(), tracebacks, and child
processes alike -- goes through a pipe that a pump thread copies, in order, to
that cell's output file, up to CAPTURE_LIMIT bytes. Output that background
processes write after their cell ended is read and discarded. The protocol
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
import select
import shutil
import signal
import subprocess
import sys
import threading
import traceback
import types

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
CELL_SOURCE_BUDGET = 1024 * 1024  # UTF-8 bytes of cell source kept for tracebacks
CAPTURE_LIMIT = 64 * 1024 * 1024  # bytes of a cell's output saved to its file


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
    if not omitted:
        return ShResult(code, (head + tail).decode(errors="replace"), 0)
    # Cut edges may split a character: drop the fragments (and count them as omitted)
    # instead of decoding them as U+FFFD.
    keep = len(head)
    lead = keep - 1
    while lead > keep - 4 and lead >= 0 and head[lead] & 0xC0 == 0x80:
        lead -= 1
    if lead >= 0:
        width = 4 if head[lead] >= 0xF0 else 3 if head[lead] >= 0xE0 else 2 if head[lead] >= 0xC0 else 1
        if keep - lead < width:
            keep = lead
    skip = 0
    while skip < min(3, len(tail)) and tail[skip] & 0xC0 == 0x80:
        skip += 1
    omitted += len(head) - keep + skip
    start = bytes(head[:keep]).decode(errors="replace")
    marker = f"\n[... {omitted} bytes omitted by sh(); redirect to a file to keep everything ...]\n"
    return ShResult(code, start + marker + tail[skip:].decode(errors="replace"), omitted)


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


class OutputPump:
    """One thread copying the running cell's output pipe to its file, up to
    CAPTURE_LIMIT bytes, and draining pipes of finished cells that background
    processes still write to (that late output is discarded, so it can never
    fill the disk and its writers never block)."""

    def __init__(self, on_overflow):
        self.on_overflow = on_overflow
        self.lock = threading.Lock()
        self.wake_r, self.wake_w = os.pipe()
        self.current = None  # [read_fd, file_fd, written]
        self.retired = set()
        self.ending = False
        self.overflowed = False
        self.ended = threading.Event()
        threading.Thread(target=self.run, daemon=True).start()

    def begin(self, path):
        """Start capturing into `path`; returns the pipe's write end for fd 1/2."""
        read_fd, write_fd = os.pipe()
        os.set_blocking(read_fd, False)
        file_fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
        with self.lock:
            self.current = [read_fd, file_fd, 0]
            self.overflowed = False
        self.wake()
        return write_fd

    def end(self):
        """After the cell released fd 1/2: save what it wrote, then retire its pipe.
        Returns True when output passed the limit."""
        self.ended.clear()
        with self.lock:
            self.ending = True
        self.wake()
        self.ended.wait()
        return self.overflowed

    def wake(self):
        os.write(self.wake_w, b"x")

    def run(self):
        while True:
            with self.lock:
                current = self.current
                watched = [self.wake_r, *self.retired] + ([current[0]] if current else [])
            ready, _, _ = select.select(watched, [], [])
            if self.wake_r in ready:
                os.read(self.wake_r, 4096)
            for fd in ready:
                if fd in self.retired:
                    self.discard(fd)
            if current and current[0] in ready:
                self.copy(current)
            with self.lock:
                finishing = self.ending and current is not None
            if finishing:
                # end() runs after the cell released fd 1/2, so this drain sees all its output.
                self.copy(current)
            with self.lock:
                if finishing:
                    os.close(current[1])
                    self.retired.add(current[0])
                    self.current = None
                    self.ending = False
                    self.ended.set()

    def copy(self, current):
        """Copy what is already in the cell's pipe (it is non-blocking). Bounded per
        call, so a writer that never pauses cannot hold the thread forever."""
        for _ in range(256):
            try:
                chunk = os.read(current[0], 1 << 16)
            except BlockingIOError:
                return
            if not chunk:
                return
            room = CAPTURE_LIMIT - current[2]
            if room > 0:
                view = memoryview(chunk)[:room]
                while view:
                    view = view[os.write(current[1], view) :]
            current[2] += len(chunk)
            if current[2] > CAPTURE_LIMIT and not self.overflowed:
                self.overflowed = True
                self.on_overflow()

    def discard(self, fd):
        try:
            while os.read(fd, 1 << 16):
                pass
        except BlockingIOError:
            return
        self.retired.discard(fd)  # end of file: every writer is gone
        os.close(fd)


class Kernel:
    def __init__(self, proto_in, proto_out, devnull):
        self.proto_in = proto_in
        self.proto_out = proto_out
        self.devnull = devnull
        self.cell = 0
        self.sources = collections.OrderedDict()  # cell filename -> source bytes
        self.source_bytes = 0
        self.reply_lock = threading.Lock()
        self.pump = OutputPump(lambda: self.reply({"overflow": True}))
        self.session_cwd = os.getcwd()
        self.loop = asyncio.new_event_loop()
        asyncio.set_event_loop(self.loop)
        # A real __main__ module, so classes defined in cells pickle and introspect normally.
        sys.modules["_pi_kernel"] = sys.modules["__main__"]  # keep the kernel module alive
        ShResult.__module__ = "_pi_kernel"  # so sh() results still pickle
        main_module = types.ModuleType("__main__")
        sys.modules["__main__"] = main_module
        self.ns = main_module.__dict__
        self.ns.update({"__builtins__": __builtins__, "sh": sh, "pip": pip})
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
        with self.reply_lock:  # the pump thread reports overflow concurrently
            self.proto_out.write(json.dumps(message) + "\n")
            self.proto_out.flush()

    def serve(self):
        self.reply({"ready": True, "python": sys.version.split()[0]})
        for line in self.proto_in:
            request = json.loads(line)
            if request["op"] == "exec":
                status, overflow = self.exec_captured(request["code"], request["output"], request.get("cwd"))
                self.reply({"id": request["id"], "status": status, "overflow": overflow})
            elif request["op"] == "names":
                self.reply({"id": request["id"], "names": self.user_names()})

    def follow_session_cwd(self, cwd):
        """Follow the session directory when it changes; a cell's own os.chdir()
        holds until it moves again. Never silently run somewhere else."""
        if not cwd:
            return True
        if cwd == self.session_cwd:
            try:
                os.getcwd()
                return True
            except FileNotFoundError:
                pass  # the directory was removed (and maybe recreated): enter it again
        try:
            os.chdir(cwd)
        except OSError as error:
            print(f"Session directory unavailable ({error.strerror}): {cwd}; the cell was not run.", file=sys.stderr)
            return False
        self.session_cwd = cwd
        return True

    def user_names(self):
        return sorted(name for name in self.ns if name not in self.baseline and not name.startswith("_"))

    def exec_captured(self, code, output_path, cwd):
        fd = self.pump.begin(output_path)
        os.dup2(fd, 1)
        os.dup2(fd, 2)
        os.close(fd)
        status = "error"
        try:
            if self.follow_session_cwd(cwd):
                status = self.run_cell(code)
        finally:
            for stream in (sys.stdout, sys.stderr):
                try:
                    stream.flush()
                except Exception:
                    pass
            os.dup2(self.devnull, 1)
            os.dup2(self.devnull, 2)
            overflow = self.pump.end()
        return status, overflow

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
        """Register a cell's source so tracebacks show its lines, within a byte budget:
        the oldest cells lose their source lines first (line numbers remain), and a
        cell larger than the whole budget is never kept."""
        size = len(code.encode("utf-8", "surrogatepass"))
        if size > CELL_SOURCE_BUDGET:
            return
        linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
        self.sources[filename] = size
        self.source_bytes += size
        while self.source_bytes > CELL_SOURCE_BUDGET:
            old, dropped = self.sources.popitem(last=False)
            linecache.cache.pop(old, None)
            self.source_bytes -= dropped

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
