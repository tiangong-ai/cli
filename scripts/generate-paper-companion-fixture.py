"""Capture the pinned producer's real PDF/JSON contract with an offline transport.

Run with the paper Skill's locked pypdf version after `npm run build`:
  python3 scripts/generate-paper-companion-fixture.py --skill-root ABS_SKILL
"""
from __future__ import annotations

import argparse
import base64
import contextlib
import importlib.metadata
import io
import json
import os
from pathlib import Path
import socket
import subprocess
import sys
import tempfile
from unittest import mock

sys.dont_write_bytecode = True
parser = argparse.ArgumentParser()
parser.add_argument("--skill-root", type=Path, required=True)
args = parser.parse_args()
skill = args.skill_root.resolve()
repo = Path(__file__).resolve().parents[1]
assert importlib.metadata.version("pypdf") == "6.14.2"
program = (
    f"import {{hashRegularTree}} from {json.dumps((repo / 'dist/research/workspace/storage.js').as_uri())};"
    f"import {{RESEARCH_SETUP_SKILLS}} from {json.dumps((repo / 'dist/research/workspace/setup-catalog.js').as_uri())};"
    "const expected=RESEARCH_SETUP_SKILLS.find(s=>s.id==='tiangong.academic-paper-download').expectedTreeSha256;"
    "const observed=await hashRegularTree(process.argv[1]);"
    "if(observed!==expected) throw new Error('Selected producer differs from the configured immutable tree');"
    "console.log(observed);"
)
tree = subprocess.check_output(["node", "--input-type=module", "-e", program, str(skill)], text=True).strip()
sys.path[:0] = [str(skill / "scripts"), str(skill / "scripts/tests")]
with mock.patch.object(socket.socket, "connect", side_effect=AssertionError("No network in fixture generation")):
    from helpers import PDF_BYTES, RoutingHttp
    from paper_fetch import cli

    url = "https://oa.example/s2.pdf"
    http = RoutingHttp(json_routes={"api.semanticscholar.org/graph/v1/paper/DOI": {
        "title": "Example paper", "year": 2024, "authors": [{"name": "Alice Example"}],
        "venue": "Journal", "openAccessPdf": {"url": url}, "externalIds": {},
    }}, download_payloads={url: PDF_BYTES})
    with tempfile.TemporaryDirectory(prefix="paper-wire-fixture-") as temporary:
        temporary = str(Path(temporary).resolve())
        output = io.StringIO()
        with mock.patch.dict(os.environ, {}, clear=True), mock.patch("paper_fetch.cli.HttpClient", return_value=http), contextlib.redirect_stdout(output), contextlib.redirect_stderr(io.StringIO()):
            assert cli.main(["10.1234/example", "--out", temporary, "--format", "json"]) == 0
        envelope = json.loads(output.getvalue())
        result = envelope["data"]["results"][0]
        assert result["success"] and result["identity_status"] == "matched"
        pdf = Path(result["file"]).read_bytes()
        manifest = json.loads(Path(result["manifest"]).read_text())

        def portable(value, key=""):
            if isinstance(value, dict):
                return {k: portable(v, k) for k, v in value.items()}
            if isinstance(value, list):
                return [portable(v) for v in value]
            if isinstance(value, str):
                if key == "retrieved_at":
                    return "2026-09-10T00:00:00Z"
                return value.replace(temporary, "<OUTPUT>")
            return value

        fixture = {
            "fixtureVersion": 1,
            "purpose": "Offline producer/consumer contract, not real acquisition evidence",
            "producerTreeSha256": tree,
            "pypdfVersion": "6.14.2",
            "normalization": "Only output-directory strings and retrieval timestamps are normalized",
            "pdfBase64": base64.b64encode(pdf).decode(),
            "envelope": portable(envelope),
            "manifest": portable(manifest),
        }
destination = repo / "test/fixtures/paper-companion-v3.json"
destination.write_text(json.dumps(fixture, ensure_ascii=False, indent=2) + "\n", encoding="utf8")
print(destination)
