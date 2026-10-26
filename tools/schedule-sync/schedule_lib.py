"""Shared logic for the drop-in schedule sync and validator (standard library only)."""
from __future__ import annotations

import csv
import io
import json
import re
from collections import Counter
from datetime import date, datetime, time, timedelta
from pathlib import Path

WEEKDAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"]
DATE_RE = re.compile(r"^(\d{1,2})/(\d{1,2})/(\d{4})$")
TIME_RE = re.compile(r"^(1[0-2]|[1-9]):([0-5]\d) (AM|PM)$")


def load_config(path: str | Path) -> dict:
    return json.loads(Path(path).read_text(encoding="utf-8"))


# ---------- CSV I/O ----------

def read_csv_text(text: str) -> list[list[str]]:
    text = text.lstrip("\ufeff")
    return [row for row in csv.reader(io.StringIO(text, newline=""))]


def write_csv_text(rows: list[list[str]]) -> str:
    buf = io.StringIO(newline="")
    csv.writer(buf, lineterminator="\r\n").writerows(rows)
    return buf.getvalue()


# ---------- Value normalization (Excel cell -> CSV text) ----------

def norm_text(v) -> str:
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return re.sub(r"\s+", " ", str(v).replace("\u00a0", " ")).strip()


def fmt_date(d: date) -> str:
    return f"{d.month}/{d.day}/{d.year}"


def fmt_minutes(total: int) -> str:
    h, m = divmod(total % 1440, 60)
    return f"{h % 12 or 12}:{m:02d} {'AM' if h < 12 else 'PM'}"


def norm_date(v) -> str:
    if isinstance(v, datetime):
        return fmt_date(v.date())
    if isinstance(v, date):
        return fmt_date(v)
    if isinstance(v, (int, float)) and not isinstance(v, bool) and 20000 < v < 80000:
        return fmt_date(date(1899, 12, 30) + timedelta(days=int(v)))
    s = norm_text(v)
    m = re.fullmatch(r"(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})", s)
    if m:
        mo, d, y = int(m[1]), int(m[2]), int(m[3])
        y = y + 2000 if y < 100 else y
        try:
            return fmt_date(date(y, mo, d))
        except ValueError:
            return s
    m = re.fullmatch(r"(\d{4})-(\d{1,2})-(\d{1,2})", s)
    if m:
        try:
            return fmt_date(date(int(m[1]), int(m[2]), int(m[3])))
        except ValueError:
            return s
    return s


def norm_time(v) -> str:
    if isinstance(v, datetime):
        v = v.time()
    if isinstance(v, time):
        return fmt_minutes(round(v.hour * 60 + v.minute + v.second / 60))
    if isinstance(v, (int, float)) and not isinstance(v, bool) and 0 <= v < 1:
        return fmt_minutes(round(v * 1440))
    s = norm_text(v)
    low = s.lower()
    if low == "noon":
        return "12:00 PM"
    m = re.fullmatch(r"(\d{1,2})(?::(\d{2}))?\s*([ap])\.?\s*m?\.?", low)
    if m:
        h, mi = int(m[1]), int(m[2] or 0)
        if 1 <= h <= 12 and mi < 60:
            return fmt_minutes((h % 12 + (12 if m[3] == "p" else 0)) * 60 + mi)
    m = re.fullmatch(r"(\d{1,2}):(\d{2})(?::\d{2})?", low)
    if m and 13 <= int(m[1]) <= 23 and int(m[2]) < 60:  # unambiguous 24-hour time
        return fmt_minutes(int(m[1]) * 60 + int(m[2]))
    return s


def norm_weekday(v) -> str:
    s = norm_text(v)
    for day in WEEKDAYS:
        if s.lower() in (day.lower(), day[:3].lower()):
            return day
    return s


def canon_choice(value: str, choices: list[str], aliases: dict | None = None) -> str:
    """Match a typed category to the allowed list, ignoring case/spacing; `aliases` maps retired names to current ones."""
    key = re.sub(r"\s+", " ", value).strip().lower()
    key = {k.lower(): v.lower() for k, v in (aliases or {}).items()}.get(key, key)
    for c in choices:
        if c.lower() == key:
            return c
    return value


# ---------- Parsing CSV text values ----------

def parse_date(s: str) -> date | None:
    m = DATE_RE.match(s)
    if not m:
        return None
    try:
        return date(int(m[3]), int(m[1]), int(m[2]))
    except ValueError:
        return None


def parse_time(s: str) -> int | None:
    m = TIME_RE.match(s)
    if not m:
        return None
    return (int(m[1]) % 12 + (12 if m[3] == "PM" else 0)) * 60 + int(m[2])


def sort_key(row: list[str]):
    d = parse_date(row[2]) if len(row) > 2 else None
    s = parse_time(row[3]) if len(row) > 3 else None
    e = parse_time(row[4]) if len(row) > 4 else None
    return (d or date.max, s if s is not None else 9999, e if e is not None else 9999,
            *[x.lower() for x in (row[0], row[1], row[5])])


# ---------- File formats ----------
# Every file is handled internally as "canonical" rows in cfg["columns"] order:
# Category, Location, Date, Start Time, End Time, Activity Name, Weekday.
# "dropin" files store exactly that. "fitness" files use the app's Group Fitness layout.

FITNESS_HEADER = ["Facility", "Location", "Code", "Date", "Start Time", "End Time", "Category", "Activity Name", "Instructor"]


def sheet_columns(spec: dict, cfg: dict) -> list[str]:
    return spec.get("sheet_columns") or cfg["columns"]


def header_detail(header: list[str], expected: list[str]) -> str:
    missing = [c for c in expected if c not in header]
    extra = [h for h in header if h and h not in expected]
    detail = []
    if missing:
        detail.append("missing " + ", ".join(f"“{c}”" for c in missing))
    if extra:
        detail.append("unexpected " + ", ".join(f"“{c}”" for c in extra))
    if not detail:
        detail.append("columns are out of order")
    return f"Column headers don't match ({'; '.join(detail)}). Expected: {', '.join(expected)}."


def to_file_rows(spec: dict, cfg: dict, canon: list[list[str]]) -> list[list[str]]:
    """Canonical rows (with header) -> rows to write to the repo file."""
    if spec.get("format") != "fitness":
        return canon
    return [FITNESS_HEADER] + [[spec["facility"], r[1], "", r[2], r[3], r[4], r[0], r[5], ""] for r in canon[1:]]


def to_canonical(spec: dict, cfg: dict, rows: list[list[str]]):
    """Repo file rows -> (canonical rows with header, header error or None, [(data index, message)])."""
    if not rows:
        return [], None, []
    header = [h.strip() for h in rows[0]]
    if spec.get("format") != "fitness":
        if header != cfg["columns"]:
            return None, header_detail(header, cfg["columns"]), []
        return [cfg["columns"]] + rows[1:], None, []
    if header != FITNESS_HEADER:
        return None, header_detail(header, sheet_columns(spec, cfg)), []
    out, issues = [cfg["columns"]], []
    for i, r in enumerate(rows[1:]):
        if not any(c.strip() for c in r):
            out.append([""] * 7)
            continue
        if len(r) != len(FITNESS_HEADER):
            out.append(r[:7] + [""] * max(0, 7 - len(r)))
            issues.append((i, f"has {len(r)} columns, expected {len(FITNESS_HEADER)}."))
            continue
        if r[0] != spec["facility"]:
            issues.append((i, f"facility “{r[0]}” should be “{spec['facility']}” or the website won't show it."))
        d = parse_date(r[3])
        out.append([r[6], r[1], r[3], r[4], r[5], r[7], WEEKDAYS[d.weekday()] if d else ""])
    return out, None, issues


# ---------- Validation ----------

class Report:
    def __init__(self):
        self.errors: dict[str, list[str]] = {}
        self.warnings: dict[str, list[str]] = {}
        self.changes: dict[str, tuple[list, list]] = {}

    def error(self, label, msg):
        self.errors.setdefault(label, []).append(msg)

    def warn(self, label, msg):
        self.warnings.setdefault(label, []).append(msg)

    @property
    def ok(self) -> bool:
        return not any(self.errors.values())


def describe(row: list[str]) -> str:
    cells = (row + [""] * 7)[:7]
    return f"{cells[2]} {cells[3]}–{cells[4]} · {cells[5] or '(no activity)'} · {cells[1] or '(no location)'}"


def validate_file(report: Report, spec: dict, cfg: dict, new_rows: list[list[str]],
                  base_rows: list[list[str]], today: date, override: bool,
                  sheet_rows: list[int] | None = None) -> None:
    label = spec["sheet"]
    rules = cfg["rules"]

    if not new_rows:
        report.error(label, "The file is empty.")
        return
    new_rows, header_error, issues = to_canonical(spec, cfg, new_rows)
    if header_error:
        report.error(label, header_error)
        return
    base_rows, base_error, _ = to_canonical(spec, cfg, base_rows)
    if base_error:
        base_rows = []
    where = (lambda i: f"sheet row {sheet_rows[i]}") if sheet_rows and len(sheet_rows) == len(new_rows) - 1 \
        else (lambda i: f"CSV line {i + 2}")
    for i, msg in issues:
        report.error(label, f"{where(i)}: {msg}")
    report.changes[label] = diff_rows(new_rows, base_rows)

    data = new_rows[1:]
    base_data = [r for r in base_rows[1:] if any(c.strip() for c in r)] if base_rows else []
    base_locations = {r[1] for r in base_data if len(r) > 1}
    base_activities = {r[5] for r in base_data if len(r) > 5}
    base_set = Counter(tuple(r) for r in base_data)

    allowed = spec["categories"]
    earliest, latest = parse_time(rules["earliest_start"]), parse_time(rules["latest_end"])
    max_ahead = today + timedelta(days=rules["max_days_ahead"])
    seen: dict[tuple, int] = {}
    real_rows = blanks = 0

    for i, row in enumerate(data):
        if not any(c.strip() for c in row):
            blanks += 1
            continue
        real_rows += 1
        if len(row) != len(cfg["columns"]):
            report.error(label, f"{where(i)}: has {len(row)} columns, expected {len(cfg['columns'])}.")
            continue
        cat, loc, ds, ss, es, act, wd = row
        what = describe(row)
        if cat not in allowed:
            report.error(label, f"{where(i)}: category “{cat}” isn't valid here (use {', '.join(allowed)}) — {what}")
        if not loc:
            report.error(label, f"{where(i)}: location is empty — {what}")
        elif spec.get("locations") and loc not in spec["locations"]:
            report.error(label, f"{where(i)}: location must be {' or '.join(spec['locations'])} — {what}")
        if not act:
            report.error(label, f"{where(i)}: activity name is empty — {what}")
        d = parse_date(ds)
        if d is None:
            report.error(label, f"{where(i)}: date “{ds}” isn't a valid date (M/D/YYYY) — {what}")
        s, e = parse_time(ss), parse_time(es)
        if s is None:
            report.error(label, f"{where(i)}: start time “{ss}” isn't a time like 9:30 AM — {what}")
        if e is None:
            report.error(label, f"{where(i)}: end time “{es}” isn't a time like 9:30 AM — {what}")
        if s is not None and e is not None:
            if e <= s:
                report.error(label, f"{where(i)}: ends at or before it starts — {what}")
            elif s < earliest or e > latest:
                report.warn(label, f"{where(i)}: unusual hours, please confirm — {what}")
        if d is not None and wd != WEEKDAYS[d.weekday()]:
            report.error(label, f"{where(i)}: {ds} is a {WEEKDAYS[d.weekday()]}, but the row says “{wd}”. Check the date.")

        key = tuple(row)
        if key in seen:
            report.error(label, f"{where(i)}: duplicate of {where(seen[key])} — {what}")
        else:
            seen[key] = i

        if base_set[key]:  # unchanged row: only structural checks above apply
            base_set[key] -= 1
            continue
        if loc and base_data and loc not in base_locations:
            report.warn(label, f"{where(i)}: new location “{loc}” — check spelling. {what}")
        if act and base_data and act not in base_activities:
            report.warn(label, f"{where(i)}: new activity name “{act}” — check spelling. {what}")
        if d is not None and d < today and base_data:
            report.warn(label, f"{where(i)}: added or changed a past date — {what}")
        if d is not None and d > max_ahead:
            report.warn(label, f"{where(i)}: more than {rules['max_days_ahead']} days ahead — {what}")

    if blanks:
        report.warn(label, f"{blanks} blank row(s) in the file (ignored by the calendar; the next sync removes them).")
    if real_rows == 0:
        report.error(label, "No schedule rows — publishing this would empty the calendar.")

    def future_count(rows):
        return sum(1 for r in rows if len(r) > 2 and (pd := parse_date(r[2])) and pd >= today)

    before, after = future_count(base_data), future_count(data)
    if before >= rules["large_change_min_rows"] and after < before:
        pct = round(100 * (before - after) / before)
        if pct > rules["large_change_max_drop_pct"]:
            msg = (f"Upcoming activities drop from {before} to {after} ({pct}% fewer). "
                   f"If this is intentional, add the “{cfg['override_label']}” label to the pull request.")
            (report.warn if override else report.error)(label, msg)


def diff_rows(new_rows, base_rows):
    def clean(rows):
        return Counter(tuple(r) for r in rows[1:] if any(c.strip() for c in r)) if rows else Counter()
    new, old = clean(new_rows), clean(base_rows)
    added = sorted((list(r) for r in (new - old).elements()), key=sort_key)
    removed = sorted((list(r) for r in (old - new).elements()), key=sort_key)
    return added, removed


# ---------- Markdown report ----------

def md_escape(s: str) -> str:
    return str(s).replace("|", "\\|").replace("\n", " ")


def render_report(report: Report, cfg: dict, meta: dict | None = None, max_list=25) -> str:
    blocks = []
    status = "✅ **Ready to publish.**" if report.ok else "❌ **Fix the errors below before publishing.**"
    blocks.append(f"## Drop-in schedule update\n\n{status}")
    if meta and meta.get("source"):
        blocks.append(meta["source"])

    labels = [s["sheet"] for s in cfg["files"]]
    for title, bucket in (("Errors (block publishing)", report.errors), ("Warnings (review, don't block)", report.warnings)):
        if any(bucket.get(l) for l in labels):
            blocks.append(f"### {title}")
            for l in labels:
                items = bucket.get(l) or []
                if not items:
                    continue
                lines = [f"**{l}**", ""] + [f"- {md_escape(m)}" for m in items[:max_list]]
                if len(items) > max_list:
                    lines.append(f"- …and {len(items) - max_list} more")
                blocks.append("\n".join(lines))

    blocks.append("### What's changing")
    any_change = False
    for l in labels:
        added, removed = report.changes.get(l, ([], []))
        if not added and not removed:
            continue
        any_change = True
        rows = sorted([("➕", r) for r in added] + [("➖", r) for r in removed], key=lambda x: sort_key(x[1]))
        short = next((f.get("format") == "fitness" for f in cfg["files"] if f["sheet"] == l), False)
        lines = [f"**{l}**: {len(added)} added, {len(removed)} removed", ""]
        lines += (["| | Date | Time | Activity |", "|---|---|---|---|"] if short else
                  ["| | Date | Time | Activity | Location | Category |", "|---|---|---|---|---|---|"])
        for sign, r in rows[:60]:
            c = (r + [""] * 7)[:7]
            cells = [sign, f"{md_escape(c[2])} ({md_escape(c[6][:3])})", f"{md_escape(c[3])}–{md_escape(c[4])}", md_escape(c[5])]
            if not short:
                cells += [md_escape(c[1]), md_escape(c[0])]
            lines.append("| " + " | ".join(cells) + " |")
        if len(rows) > 60:
            lines += ["", f"…and {len(rows) - 60} more rows; see **Files changed**."]
        blocks.append("\n".join(lines))
    if not any_change:
        blocks.append("No schedule rows changed.")
    blocks.append("A changed row shows as one ➖ and one ➕. Updates that pass every check are published automatically.")
    return "\n\n".join(blocks) + "\n"
