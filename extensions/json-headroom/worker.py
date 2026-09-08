"""Offline, lossless-only Headroom adapter. One bounded JSON document per process.

The pilot accepts flat homogeneous record arrays (optionally one top-level field).
It verifies every CSV cell against the input; unsupported shapes stay unchanged.
No routing, neural models, CCR store, or conversation history is used.
"""
import csv
import hashlib
import io
import json
import math
import re
import socket
import sys
from decimal import Decimal
from importlib.metadata import version

MAX_BYTES = 256 * 1024
VERSION = "0.37.0"


def offline(*_args, **_kwargs):
    raise RuntimeError("network is disabled in the JSON worker")


socket.socket.connect = offline
socket.socket.connect_ex = offline
socket.create_connection = offline


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate JSON key")
        result[key] = value
    return result


def reject_constant(_value):
    raise ValueError("non-JSON number")


def precise_float(token):
    value = float(token)
    if not math.isfinite(value) or Decimal(token) != Decimal(str(value)):
        raise ValueError("unsafe JSON decimal")
    return value


def precise_int(token):
    if token == "-0":
        raise ValueError("signed integer zero")
    return int(token)


def scalar_type(value):
    if isinstance(value, str):
        return "string"
    if type(value) is bool:
        return "bool"
    if type(value) is int and abs(value) <= 2**53 - 1:
        return "int"
    if type(value) is float and math.isfinite(value):
        return "float"
    return None


def compact(text):
    data = json.loads(text, object_pairs_hook=unique_object, parse_constant=reject_constant, parse_float=precise_float, parse_int=precise_int)
    field = None
    if isinstance(data, dict):
        arrays = [key for key, value in data.items() if isinstance(value, list)]
        if len(arrays) != 1:
            return None
        field = arrays[0]
        if any(scalar_type(value) is None for key, value in data.items() if key != field):
            return None
        if data.get("ok") is False or data.get("success") is False or "error" in data or "errors" in data:
            return None
    rows = data[field] if field is not None else data
    if not isinstance(rows, list) or not 20 <= len(rows) <= 5000:
        return None
    if not isinstance(rows[0], dict) or not 1 <= len(rows[0]) <= 64:
        return None
    keys = sorted(rows[0])
    if any(not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]{0,63}", key) for key in keys):
        return None
    if "error" in keys or "errors" in keys:
        return None
    types = [scalar_type(rows[0][key]) for key in keys]
    if None in types:
        return None
    for row in rows:
        if not isinstance(row, dict) or sorted(row) != keys:
            return None
        if [scalar_type(row[key]) for key in keys] != types:
            return None
    from headroom.config import CCRConfig
    from headroom.transforms.smart_crusher import SmartCrusher

    crusher = SmartCrusher(
        lossless_only=True,
        compaction_format="csv-schema",
        ccr_config=CCRConfig(enabled=False, inject_retrieval_marker=False),
    )
    result = crusher.crush_array_json(json.dumps(rows, ensure_ascii=False))
    table = result.get("compacted")
    if result.get("compaction_kind") != "table" or not isinstance(table, str):
        return None
    if result.get("ccr_hash") or result.get("dropped_summary") or "<<ccr:" in table:
        return None
    # Validate the rendered table, not merely Headroom's retained-items metadata.
    header, separator, body = table.partition("\n")
    expected_header = f"[{len(rows)}]{{" + ",".join(f"{key}:{kind}" for key, kind in zip(keys, types)) + "}"
    if not separator or header != expected_header:
        return None
    cells = list(csv.reader(io.StringIO(body, newline=""), strict=True))
    if len(cells) != len(rows):
        return None
    for row, values in zip(rows, cells):
        if len(values) != len(keys):
            return None
        for key, kind, cell in zip(keys, types, values):
            value = row[key]
            if kind == "string":
                if cell != value:
                    return None
            else:
                decoded = json.loads(cell, parse_constant=reject_constant, parse_float=precise_float, parse_int=precise_int)
                # Preserve numeric values and distinctions such as 1 versus true.
                if type(decoded) is not type(value) or decoded != value:
                    return None
                if kind == "float" and value == 0 and math.copysign(1, decoded) != math.copysign(1, value):
                    return None
    if field is not None:
        data[field] = table
        return json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    return table


def main():
    if version("headroom-ai") != VERSION:
        raise RuntimeError("unsupported Headroom version")
    raw = sys.stdin.buffer.read(MAX_BYTES + 1)
    if len(raw) > MAX_BYTES:
        raise ValueError("input too large")
    text = raw.decode("utf-8", errors="strict")
    try:
        result = compact(text)
    except (ValueError, TypeError, RecursionError, OverflowError, csv.Error):
        result = None
    response = {"sha256": hashlib.sha256(raw).hexdigest(), "text": result}
    sys.stdout.write(json.dumps(response, ensure_ascii=False, separators=(",", ":")))


if __name__ == "__main__":
    main()
