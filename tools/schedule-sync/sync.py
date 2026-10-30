"""Download the drop-in schedule workbook from SharePoint and write the site's CSV files.

Usage:
  python sync.py --repo ../..                      # fetch from SharePoint via Microsoft Graph
  python sync.py --repo ../.. --workbook file.xlsx  # convert a local copy (testing)

Graph settings come from repository variables: MS_TENANT_ID, MS_CLIENT_ID, SP_HOSTNAME,
SP_SITE_PATH, SP_FILE_PATH, SP_DRIVE_NAME. Sign-in uses GitHub's OIDC token (federated
credential); MS_CLIENT_SECRET is only a fallback.
"""
from __future__ import annotations

import argparse
import base64
import io
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime
from pathlib import Path
from zoneinfo import ZoneInfo

from openpyxl import load_workbook

import schedule_lib as lib

HERE = Path(__file__).resolve().parent
GRAPH = "https://graph.microsoft.com/v1.0"


HINTS = {
    "AADSTS700213": "The federated credential doesn't match this workflow. Copy the subject quoted above "
                    "(repo:…) into the credential's subject in Entra, character for character.",
    "AADSTS70021": "The federated credential doesn't match this workflow. Check the issuer "
                   "(https://token.actions.githubusercontent.com), audience (api://AzureADTokenExchange) and subject.",
    "AADSTS700016": "MS_CLIENT_ID wasn't found in this tenant. Copy the Application (client) ID from the app's Overview page.",
    "AADSTS90002": "MS_TENANT_ID wasn't found. Copy the Directory (tenant) ID from the app's Overview page.",
    "AADSTS900023": "MS_TENANT_ID isn't a valid tenant ID. Copy the Directory (tenant) ID from the app's Overview page.",
    "AADSTS7000215": "MS_CLIENT_SECRET is wrong or expired.",
}
GRAPH_HINTS = {
    401: "The token has no usable Microsoft Graph permission. In Entra › API permissions, Sites.Selected must be listed under "
         "Microsoft Graph (not SharePoint), with type Application (not Delegated), and show “Granted for …”.",
    403: "The app signed in but has no access to this site. Run the site grant (POST …/sites/{site-id}/permissions with "
         "role read) for the site named in SP_HOSTNAME + SP_SITE_PATH.",
    404: "Not found. Check SP_HOSTNAME, SP_SITE_PATH, SP_DRIVE_NAME and SP_FILE_PATH against the workbook's address.",
}


class StepFailed(SystemExit):
    pass


def fail(step, url, code, detail, hint=""):
    where = urllib.parse.urlsplit(url)
    lines = [f"✖ {step} failed: HTTP {code} from {where.netloc}{where.path}", f"  Microsoft says: {detail}"]
    if hint:
        lines.append(f"  Likely fix: {hint}")
    raise StepFailed("\n".join(lines))


def http_json(step, url, token=None, data=None, headers=None):
    h = {"Accept": "application/json", **(headers or {})}
    if token:
        h["Authorization"] = f"Bearer {token}"
    try:
        with urllib.request.urlopen(urllib.request.Request(url, data=data, headers=h), timeout=60) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        try:
            j = json.loads(body)
        except ValueError:
            j = {}
        if "error_description" in j:  # Entra sign-in errors
            detail = j["error_description"].split("Trace ID")[0].strip()
            code = next((c for c in HINTS if detail.startswith(c + ":")), "")
            fail(step, url, e.code, detail, HINTS.get(code, ""))
        if isinstance(j.get("error"), dict):  # Microsoft Graph errors
            err = j["error"]
            fail(step, url, e.code, f"{err.get('code')}: {err.get('message')}", GRAPH_HINTS.get(e.code, ""))
        fail(step, url, e.code, body[:500] or e.reason, GRAPH_HINTS.get(e.code, "") if "graph" in url else "")


def token_claims(token: str) -> dict:
    payload = token.split(".")[1]
    return json.loads(base64.urlsafe_b64decode(payload + "=" * (-len(payload) % 4)))


def client_credentials(env) -> dict:
    """Prefer GitHub's OIDC token (federated credential, nothing stored); fall back to a client secret."""
    if env.get("ACTIONS_ID_TOKEN_REQUEST_URL") and not env.get("MS_CLIENT_SECRET"):
        assertion = http_json("GitHub sign-in token", env["ACTIONS_ID_TOKEN_REQUEST_URL"] + "&audience=api://AzureADTokenExchange",
                              headers={"Authorization": f"bearer {env['ACTIONS_ID_TOKEN_REQUEST_TOKEN']}"})["value"]
        print(f"GitHub identity presented to Microsoft: {token_claims(assertion).get('sub')}")
        return {"client_assertion_type": "urn:ietf:params:oauth:client-assertion-type:jwt-bearer",
                "client_assertion": assertion}
    if env.get("MS_CLIENT_SECRET"):
        return {"client_secret": env["MS_CLIENT_SECRET"]}
    sys.exit("No credential: grant the workflow id-token: write (federated credential) or set MS_CLIENT_SECRET.")


def fetch_from_sharepoint() -> tuple[bytes, dict]:
    env = os.environ
    missing = [k for k in ("MS_TENANT_ID", "MS_CLIENT_ID", "SP_HOSTNAME", "SP_SITE_PATH", "SP_FILE_PATH")
               if not env.get(k)]
    if missing:
        sys.exit(f"Missing settings: {', '.join(missing)}")

    token = http_json(
        "Microsoft sign-in",
        f"https://login.microsoftonline.com/{env['MS_TENANT_ID']}/oauth2/v2.0/token",
        data=urllib.parse.urlencode({
            "grant_type": "client_credentials",
            "client_id": env["MS_CLIENT_ID"],
            "scope": "https://graph.microsoft.com/.default",
            **client_credentials(env),
        }).encode(),
    )["access_token"]
    claims = token_claims(token)
    roles = claims.get("roles") or []
    print(f"Signed in to Microsoft as app {claims.get('appid')} (tenant {claims.get('tid')}); "
          f"Graph permissions in token: {', '.join(roles) or 'none'}")
    if not roles:
        sys.exit("✖ Microsoft sign-in worked, but the token carries no Microsoft Graph application permissions.\n"
                 "  Likely fix: " + GRAPH_HINTS[401])

    site_path = "/" + env["SP_SITE_PATH"].strip("/")
    site = http_json("Find SharePoint site", f"{GRAPH}/sites/{env['SP_HOSTNAME']}:{urllib.parse.quote(site_path)}", token)
    drive_name = env.get("SP_DRIVE_NAME") or "Documents"
    drives = http_json("List document libraries", f"{GRAPH}/sites/{site['id']}/drives", token)["value"]
    drive = next((d for d in drives if d["name"].lower() == drive_name.lower()), None)
    if not drive:
        sys.exit(f"✖ Document library “{drive_name}” not found on the site. Libraries found: "
                 f"{', '.join(d['name'] for d in drives) or 'none'}. Set SP_DRIVE_NAME to the right one.")

    file_path = urllib.parse.quote(env["SP_FILE_PATH"].strip("/"))
    item = http_json("Find workbook", f"{GRAPH}/drives/{drive['id']}/root:/{file_path}", token)
    # The pre-authenticated download URL must be fetched without the Graph token.
    try:
        with urllib.request.urlopen(item["@microsoft.graph.downloadUrl"], timeout=120) as r:
            content = r.read()
    except urllib.error.HTTPError as e:
        fail("Download workbook", item["@microsoft.graph.downloadUrl"], e.code, e.reason)

    meta = {"modified": item.get("lastModifiedDateTime"),
            "editor": (item.get("lastModifiedBy") or {}).get("user", {}).get("displayName"),
            "url": item.get("webUrl")}
    return content, meta


def sheet_to_rows(ws, spec, cfg):
    """Return (canonical rows, sheet_row_numbers). Falls back to raw text if required headers are missing."""
    columns, wanted = cfg["columns"], lib.sheet_columns(spec, cfg)
    fixed = spec.get("fixed", {})
    rows = list(ws.iter_rows(values_only=True))
    numbered = [(n, r) for n, r in enumerate(rows, start=1) if any(lib.norm_text(v) for v in (r or ()))]
    if not numbered:
        return [columns], []
    header_n, header = numbered[0]
    names = [lib.norm_text(h) for h in header]
    index = {}
    for col in wanted:
        hit = [i for i, h in enumerate(names) if h.lower() == col.lower()]
        if hit:
            index[col] = hit[0]

    if any(c not in index for c in wanted if c != "Weekday"):
        # Leave the problem visible: the validator reports the header mismatch on the pull request.
        raw = [[n for n in names if n]] + [[lib.norm_text(v) for v in r][:len(names)] for _, r in numbered[1:]]
        return raw, [n for n, _ in numbered[1:]]

    def cell(r, col):
        if col in fixed:
            return fixed[col]
        i = index.get(col)
        return r[i] if i is not None and i < len(r) else None

    out = []
    for n, r in numbered[1:]:
        if not any(lib.norm_text(r[index[c]]) for c in wanted if c != "Weekday" and index[c] < len(r)):
            continue  # blank row, even if a Weekday formula is present
        cat = lib.canon_choice(lib.norm_text(cell(r, "Category")), spec["categories"])
        loc = lib.norm_text(cell(r, "Location"))
        ds = lib.norm_date(cell(r, "Date"))
        ss, es = lib.norm_time(cell(r, "Start Time")), lib.norm_time(cell(r, "End Time"))
        act = lib.norm_text(cell(r, "Activity Name"))
        wd = lib.norm_weekday(cell(r, "Weekday"))
        d = lib.parse_date(ds)
        if not wd and d:
            wd = lib.WEEKDAYS[d.weekday()]
        out.append(([cat, loc, ds, ss, es, act, wd], n))

    out.sort(key=lambda x: lib.sort_key(x[0]))
    return [columns] + [r for r, _ in out], [n for _, n in out]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=".", help="repository root where the CSV files live")
    ap.add_argument("--config", default=str(HERE / "config.json"))
    ap.add_argument("--workbook", help="local .xlsx instead of SharePoint")
    ap.add_argument("--meta-out", default="sync-meta.json")
    args = ap.parse_args()
    cfg = lib.load_config(args.config)

    if args.workbook:
        content, meta = Path(args.workbook).read_bytes(), {"modified": None, "editor": None, "url": None}
    else:
        content, meta = fetch_from_sharepoint()

    wb = load_workbook(io.BytesIO(content), data_only=True, read_only=True)
    sheets = {ws.title.strip().lower(): ws for ws in wb.worksheets}
    sheet_rows = {}
    for spec in cfg["files"]:
        ws = sheets.get(spec["sheet"].lower())
        if ws is None:
            sys.exit(f"Workbook has no sheet named “{spec['sheet']}”. Sheets found: {', '.join(wb.sheetnames)}")
        rows, numbers = sheet_to_rows(ws, spec, cfg)
        if rows and rows[0] == cfg["columns"]:
            rows = lib.to_file_rows(spec, cfg, rows)
        (Path(args.repo) / spec["csv"]).write_text(lib.write_csv_text(rows), encoding="utf-8", newline="")
        sheet_rows[spec["sheet"]] = numbers
        print(f"{spec['sheet']}: {len(rows) - 1} rows -> {spec['csv']}")

    source = None
    if meta.get("modified"):
        when = datetime.fromisoformat(meta["modified"].replace("Z", "+00:00")).astimezone(ZoneInfo(cfg["timezone"]))
        who = f" by {meta['editor']}" if cfg.get("show_editor_name") and meta.get("editor") else ""
        source = f"Workbook last saved{who} on {when:%a %b %-d, %-I:%M %p}."
    Path(args.meta_out).write_text(json.dumps({"source": source, "sheet_rows": sheet_rows}), encoding="utf-8")


if __name__ == "__main__":
    main()
