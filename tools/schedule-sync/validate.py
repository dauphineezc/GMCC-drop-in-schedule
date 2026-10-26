"""Check the drop-in schedule CSVs against the live versions and write a Markdown report.

Exit code 1 means at least one error; the report says what to fix.

Usage:
  python validate.py --repo ../.. --base-ref origin/main [--meta sync-meta.json] [--override] [--report report.md]
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
from datetime import date, datetime
from pathlib import Path
from zoneinfo import ZoneInfo

import schedule_lib as lib

HERE = Path(__file__).resolve().parent


def git_show(repo: str, ref: str, path: str) -> str:
    r = subprocess.run(["git", "-C", repo, "show", f"{ref}:{path}"], capture_output=True, text=True, encoding="utf-8")
    return r.stdout if r.returncode == 0 else ""


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".")
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--base-ref", default="origin/main", help="what's live now")
    ap.add_argument("--meta", help="sync-meta.json written by sync.py")
    ap.add_argument("--override", action="store_true", help="allow a large drop in upcoming rows")
    ap.add_argument("--today", help="YYYY-MM-DD (testing)")
    ap.add_argument("--report", default="schedule-report.md")
    args = ap.parse_args()

    cfg = lib.load_config(args.config)
    today = date.fromisoformat(args.today) if args.today else datetime.now(ZoneInfo(cfg["timezone"])).date()
    meta = json.loads(Path(args.meta).read_text(encoding="utf-8")) if args.meta and Path(args.meta).exists() else {}

    report = lib.Report()
    for spec in cfg["files"]:
        path = Path(args.repo) / spec["csv"]
        new_rows = lib.read_csv_text(path.read_text(encoding="utf-8")) if path.exists() else []
        base_rows = lib.read_csv_text(git_show(args.repo, args.base_ref, spec["csv"]))
        lib.validate_file(report, spec, cfg, new_rows, base_rows, today, args.override,
                          (meta.get("sheet_rows") or {}).get(spec["sheet"]))

    md = lib.render_report(report, cfg, meta)
    Path(args.report).write_text(md, encoding="utf-8")
    print(md)
    sys.exit(0 if report.ok else 1)


if __name__ == "__main__":
    main()
