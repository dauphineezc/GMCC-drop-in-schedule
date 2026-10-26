# Drop-in schedule sync

Staff edit the drop-in schedules in an Excel workbook on SharePoint. Every 15 minutes, around the clock, `schedule-sync.yml` downloads the workbook and converts each sheet to its CSV. If anything changed, it opens or updates a pull request from the `schedule-sync` branch and runs the validator. **If there are no errors, it merges the pull request itself and Vercel publishes it. If there are errors, nothing is published**: the live site keeps the last good schedule, the pull request stays open with the errors listed by sheet row, and the workflow run is marked failed. No human approval is involved, so the validator is the only gate. The pull request and its merge commit are the audit trail.

Group Fitness at the Community, Coleman and North centers is not part of this. It still comes from RecTrac exports in Azure Blob (`FR.csv`, `FR_CFC.csv`, `FR_NFC.csv`). Tennis Center classes are part of it, because they aren't in RecTrac.

| Sheet | File | Allowed categories |
|---|---|---|
| Community Center | `GMCC_Drop_In_Schedule.csv` | Aquatics, Court Sports, Community, Kids Activities (the retired name "Child Watch" is still accepted and converted) |
| Tennis Center | `TC_Fitness_Schedule.csv` (Group Fitness layout) | none (sheet has no Category or Location) |
| Coleman Family Center | `CFC_Drop_In_Schedule.csv` | Court Sports |
| North Family Center | `NFC_Drop_In_Schedule.csv` | Court Sports |
| Curling Center | `GMCurling_Schedule.csv` | League |

Sheets and columns are set in `config.json`. Drop-in sheets use `Category, Location, Date, Start Time, End Time, Activity Name, Weekday`. The Tennis Center sheet uses `Date, Start Time, End Time, Activity Name, Weekday`. The sync writes it in the app's Group Fitness layout, with Facility and Location set to `Tennis Center` and Category set to `Scheduled Program`. Extra columns to the right are ignored, and an empty Weekday is filled in from the date.

## One-time setup

1. **App change for Tennis Center (one commit).** Apply `tennis-center-app.patch` (`git apply tennis-center-app.patch`) and commit it together with `TC_Fitness_Schedule.csv`. The patch points the Tennis Center calendar at the repo file instead of `FR_TC.csv` on Blob. The seed file holds the 360 classes from the last `FR_TC.csv` export (Sep 7–Dec 20, 2026), so the calendar never goes blank. After this ships, `FR_TC.csv` on Blob is unused, and whoever uploads it can stop.
2. **Workbook.** Upload `Drop-In Schedules.xlsx` to the Marketing Resources site, in **Apps › Weekly Schedule**. It is seeded from the repo CSVs as of Oct 23, 2026 (commit `24c3846`), plus the Tennis Center seed. Give staff edit access. Don't rename the sheets or the header row.
3. **Microsoft sign-in (ITRM).** In Entra ID:
   - Register an app, for example "GMCC schedule sync".
   - Add the Microsoft Graph **application** permission `Sites.Selected` and grant admin consent.
   - Grant the app **read** on that one site: `POST https://graph.microsoft.com/v1.0/sites/{site-id}/permissions` with `{"roles":["read"],"grantedToIdentities":[{"application":{"id":"<client-id>","displayName":"GMCC schedule sync"}}]}`.
   - Under **Certificates & secrets → Federated credentials**, add a "GitHub Actions" credential: organization `dauphineezc`, repository name spelled exactly as GitHub shows it, entity type **Branch**, branch `main`.

   No client secret is needed. `MS_CLIENT_SECRET`, as a repo secret, is only a fallback.
4. **Repository variables** (Settings → Secrets and variables → Actions → Variables):
   - `MS_TENANT_ID`, `MS_CLIENT_ID`
   - `SP_HOSTNAME`, for example `greatermidland.sharepoint.com`
   - `SP_SITE_PATH`, the Marketing Resources site, for example `/sites/MarketingResources`
   - `SP_FILE_PATH`, the path inside the library: `Apps/Weekly Schedule/Drop-In Schedules.xlsx`
   - `SP_DRIVE_NAME`, only if the library isn't "Documents"
5. **Actions setting.** Under Settings → Actions → General, turn on "Allow GitHub Actions to create and approve pull requests".
6. **Branch rules.** Don't require pull request reviews, Code Owners or the `schedule-validation` status on `main`. The sync workflow merges its own pull request, but only after running the validator itself, so a required review would block it. If you add a ruleset anyway, let `github-actions` bypass it. Anyone with write access can still add the `allow-large-change` label (see below), so keep write access to the people who should be able to do that.
7. **Failure alerts (none configured).** The sync sends no notifications. A blocked update shows as a red run in the Actions tab and an open schedule-sync pull request listing the errors, and GitHub emails the person who last edited the workflow's schedule. The live site keeps the last good schedule. If you want Teams alerts later, add a step that posts to a Power Automate webhook when `RESULT` is non-zero.
8. **First run.** Go to Actions → "Sync drop-in schedules from SharePoint" → Run workflow. The first pull request reports "No schedule rows changed" but shows a large file diff. That's a one-time re-sort and the removal of 1,953 blank rows in the North file. It merges itself.

## Day to day

- **Staff** edit the workbook and nothing else. Within 15 minutes the change is validated and, if clean, published (the site updates about a minute after that). Closing a pull request doesn't discard edits: the next run reopens it until the workbook matches the live site.
- **Nobody approves routine changes.** The team only steps in when the check fails and staff can't fix it, or for a large-removal override.
- **Errors** name the sheet row. Staff fix the row in the workbook, and the pull request updates on the next run.
- **Large removals.** If more than 25% of upcoming rows disappear, the check fails. If that's intentional, add the label `allow-large-change` to the open pull request. This is the one human decision. The next run (within 15 minutes) re-validates with the override and publishes.
- **Urgent changes.** Use Actions → Run workflow to skip the wait. It publishes the same way.
- **Pausing auto-publish.** Disable the "Sync drop-in schedules from SharePoint" workflow in the Actions tab. Re-enable it when ready. GitHub also disables scheduled workflows in a public repo after 60 days with no repository activity, so if the schedule is quiet for that long, re-enable it.
- **Don't hand-edit the CSVs.** The next sync overwrites them with the workbook's contents.

## Local testing

```bash
pip install -r tools/schedule-sync/requirements.txt
python tools/schedule-sync/sync.py --repo . --workbook "Drop-In Schedules.xlsx"
python tools/schedule-sync/validate.py --repo . --base-ref origin/main --meta sync-meta.json
```

If the workbook can't be downloaded or a sheet is missing, the workflow run fails. GitHub then emails whoever last edited the workflow's schedule.
