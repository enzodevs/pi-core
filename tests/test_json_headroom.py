"""Optional real-engine contract tests: make headroom-test."""
import importlib.util
import json
import socket
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location(
    "json_headroom_worker", Path(__file__).resolve().parents[1] / "extensions/json-headroom/worker.py"
)
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def services():
    rows = [{"id": f"svc-{i:04d}", "status": "healthy", "latency_ms": 12, "description": "background queue processor"} for i in range(400)]
    rows[173].update(status="failed", latency_ms=9100, description="CERT_RENEWAL_EXPIRED_173")
    rows[217]["description"] = "ROUTING_OVERRIDE_217"
    return rows


class LosslessHeadroom(unittest.TestCase):
    def test_middle_evidence_and_all_rows_survive(self):
        rows = services()
        original = json.dumps({"services": rows, "total": 400})
        result = worker.compact(original)
        self.assertIsNotNone(result)
        self.assertLess(len(result), len(original) * 0.8)
        for marker in ["CERT_RENEWAL_EXPIRED_173", "ROUTING_OVERRIDE_217", "9100"]:
            self.assertIn(marker, result)
        for row in rows:
            self.assertIn(row["id"], result)
        self.assertEqual(json.loads(result)["total"], 400)

    def test_normal_target_in_middle(self):
        rows = [{"customer": f"customer-{i:04d}", "tier": "standard", "quota": 100.0} for i in range(400)]
        rows[219].update(customer="MERIDIAN_TARGET_219", quota=103.75)
        result = worker.compact(json.dumps(rows))
        self.assertIsNotNone(result)
        self.assertIn("MERIDIAN_TARGET_219", result)
        self.assertIn("103.75", result)

    def test_csv_escaping_unicode_empty_strings_and_types(self):
        rows = [{"id": i, "name": 'hello,\n"世界"\r\n', "empty": "", "bool": False, "float": 1.25, "literal": "null"} for i in range(50)]
        result = worker.compact(json.dumps(rows))
        self.assertIsNotNone(result)
        self.assertIn("name:string", result)
        self.assertIn("bool:bool", result)

    def test_conservative_unsupported_shapes(self):
        fixtures = [
            [{"id": i, "nested": {"x": 1}} for i in range(30)],
            [{"id": i, "nil": None} for i in range(30)],
            [{"id": i, "mixed": i if i % 2 else "x"} for i in range(30)],
            [{"id": i, "big": 2**53 + 1} for i in range(30)],
            [{"id": i, "bad:key": "value"} for i in range(30)],
            [{"id": i, "error": "failure"} for i in range(30)],
            {"ok": False, "results": services()},
            {"errors": [], "results": services()},
            {"a": services(), "b": services()},
            services()[:3],
            "not an array",
        ]
        for value in fixtures:
            with self.subTest(value=str(value)[:60]):
                self.assertIsNone(worker.compact(json.dumps(value)))

    def test_duplicate_keys_and_non_json_numbers_rejected(self):
        for text in ['{"x":1,"x":2}', '[{"n":NaN}]', '[{"n":Infinity}]', '[{"n":0.10000000000000000001}]', '[{"n":1e999}]', '[{"n":-0}]']:
            with self.assertRaises(ValueError):
                worker.compact(text)

    def test_engine_output_is_verified_not_trusted(self):
        from headroom.transforms.smart_crusher import SmartCrusher
        rows = services()
        original = json.dumps(rows)
        valid = SmartCrusher(lossless_only=True).crush_array_json(original)
        self.assertEqual(valid["compaction_kind"], "table")
        corruptions = [
            {**valid, "compacted": valid["compacted"].replace("CERT_RENEWAL_EXPIRED_173", "lost")},
            {**valid, "compacted": valid["compacted"].replace("[400]", "[399]")},
            {**valid, "ccr_hash": "opaque-recovery-key"},
            {**valid, "dropped_summary": "omitted rows"},
            {**valid, "compacted": valid["compacted"] + "extra,row\n"},
            {**valid, "compaction_kind": "unknown"},
        ]
        for result in corruptions:
            with self.subTest(result=str(result)[:60]):
                with patch("headroom.transforms.smart_crusher.SmartCrusher") as factory:
                    factory.return_value.crush_array_json.return_value = result
                    self.assertIsNone(worker.compact(original))

    def test_worker_network_is_disabled(self):
        with self.assertRaisesRegex(RuntimeError, "network is disabled"):
            socket.create_connection(("example.invalid", 443))


if __name__ == "__main__":
    unittest.main()
