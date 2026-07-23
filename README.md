# GMCC Drop-In Schedule

Interactive schedule calendars for Greater Midland Community Center (GMCC) facilities. The app displays drop-in activities and group fitness classes across four centers, with views designed for both standalone browsing and embedding on [greatermidland.org](https://greatermidland.org).

**Production site:** [gmcc-drop-in-schedule.vercel.app](https://gmcc-drop-in-schedule.vercel.app)

## Calendar views

### Weekly calendar (`index.html`)

Full week grid with day columns, time slots, and sub-calendar tabs (Aquatics, Court Sports, etc.). Users can switch centers via the dropdown.

| View | Link |
|------|------|
| Weekly (center dropdown visible) | [index.html](https://gmcc-drop-in-schedule.vercel.app/) |

**Center-locked weekly presets** — pass `?center=<key>` to hide the dropdown and show a fixed center label. Useful for embedding a single facility on its own page.

| Center | Key | Link |
|--------|-----|------|
| Community Center | `community` | [?center=community](https://gmcc-drop-in-schedule.vercel.app/?center=community) |
| Tennis Center | `tennis` | [?center=tennis](https://gmcc-drop-in-schedule.vercel.app/?center=tennis) |
| Coleman Family Center | `coleman` | [?center=coleman](https://gmcc-drop-in-schedule.vercel.app/?center=coleman) |
| North Family Center | `north` | [?center=north](https://gmcc-drop-in-schedule.vercel.app/?center=north) |

### Today's schedule — all centers (`today.html`)

Compact list of today's activities for all four centers side by side. On mobile, each center section is collapsible (Community Center expanded by default).

| View | Link |
|------|------|
| Today (all centers) | [today.html](https://gmcc-drop-in-schedule.vercel.app/today.html) |

### Today's schedule — single center (`today-center.html`)

Single-center daily list with a fixed header. Intended for per-facility embeds.

| Center | Link |
|--------|------|
| Community Center | [today-center.html?center=community](https://gmcc-drop-in-schedule.vercel.app/today-center.html?center=community) |
| Tennis Center | [today-center.html?center=tennis](https://gmcc-drop-in-schedule.vercel.app/today-center.html?center=tennis) |
| Coleman Family Center | [today-center.html?center=coleman](https://gmcc-drop-in-schedule.vercel.app/today-center.html?center=coleman) |
| North Family Center | [today-center.html?center=north](https://gmcc-drop-in-schedule.vercel.app/today-center.html?center=north) |

## URL parameters

### Weekly calendar (`index.html`)

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `center` | `community`, `tennis`, `coleman`, `north` | `community` | When present and valid, locks the center picker (dropdown hidden) |
| `type` | `dropin`, `fitness` | `dropin` | Primary calendar type. `fitness` is only available for Community Center |
| `sub` | See sub-calendars below | `aquatics` | Active sub-calendar tab |
| `w` | `YYYY-MM-DD` | Current week's Monday | Week start date |

**Drop-in sub-calendars:** `aquatics`, `courtSports`, `community`, `childWatch`

**Group fitness sub-calendars:** `aquatics`, `studio1`, `studio2`, `mac`

Examples:

- Community Center, Group Fitness, Studio 1:  
  `https://gmcc-drop-in-schedule.vercel.app/?center=community&type=fitness&sub=studio1`
- Tennis Center, Court Sports:  
  `https://gmcc-drop-in-schedule.vercel.app/?center=tennis&sub=courtSports`
- Specific week starting July 14, 2026:  
  `https://gmcc-drop-in-schedule.vercel.app/?w=2026-07-14`

### Today views (`today.html`, `today-center.html`)

| Parameter | Values | Default | Description |
|-----------|--------|---------|-------------|
| `date` | `YYYY-MM-DD` (flexible formats accepted) | Today | Date to display |
| `center` | `community`, `tennis`, `coleman`, `north` | `community` | *(today-center.html only)* Which center to show |

Example — tomorrow's schedule for Coleman:

`https://gmcc-drop-in-schedule.vercel.app/today-center.html?center=coleman&date=2026-07-21`

## Tech stack

| Layer | Technology |
|-------|------------|
| Frontend | Static HTML, vanilla JavaScript, [Tailwind CSS](https://tailwindcss.com) (CDN) |
| Fonts | [Inter](https://fonts.google.com/specimen/Inter) via Google Fonts |
| Data | CSV files fetched at runtime (drop-in + group fitness) |
| Hosting | [Vercel](https://vercel.com) (static deploy, no build step) |
| Data pipeline | GitHub Actions + Playwright scraper exports RecTrac CSVs to Azure Blob / S3 |

There is no bundler or framework — pages load `./js/schedule-data.js` directly and render client-side.

## Project structure

```
├── index.html              # Weekly calendar
├── today.html              # Today's schedule (all centers)
├── today-center.html       # Today's schedule (single center)
├── js/
│   ├── schedule-data.js    # Centers config, CSV parsing, shared helpers
│   └── embed-height.js     # iframe height messaging for parent pages
├── GMCC_Drop_In_Schedule.csv   # Local fallback drop-in data
├── test-schedule.csv           # Local fallback fitness data
└── scripts/
    └── export-reservations.js  # RecTrac CSV export (CI only)
```

## Running locally

This is a static site — any local HTTP server works. From the project root:

**Option A — npx serve (recommended)**

```bash
npx serve .
```

Then open [http://localhost:3000](http://localhost:3000).

**Option B — Python**

```bash
# Python 3
python -m http.server 8080
```

Then open [http://localhost:8080](http://localhost:8080).

**Option C — VS Code / Cursor Live Server**

Open any HTML file and use the Live Server extension.

### Local data behavior

When running on `localhost` or `127.0.0.1`, the app prefers local CSV fallbacks to avoid CORS issues with remote blob storage:

- Drop-in: `./GMCC_Drop_In_Schedule.csv`
- Group fitness: `./test-schedule.csv`

In production, data is loaded from Azure Blob Storage (`recscheduler.blob.core.windows.net`).

## Embedding

The today views post a `gmcc-schedule-height` message to the parent window so iframes can resize to content height. Example:

```html
<iframe
  src="https://gmcc-drop-in-schedule.vercel.app/today-center.html?center=community"
  width="100%"
  frameborder="0"
  scrolling="no"
></iframe>
```

Listen for height updates on the parent page:

```javascript
window.addEventListener('message', (e) => {
  if (e.data?.type === 'gmcc-schedule-height') {
    iframe.style.height = `${e.data.height}px`;
  }
});
```

## Deployment

The site deploys to Vercel as static files. The `vercel-build` script is a no-op — there is nothing to compile. Push to the connected Git branch to trigger a deploy.

## Data updates

Drop-in and group fitness schedules are exported daily from RecTrac via the `Export RecTrac CSV` GitHub Actions workflow (`.github/workflows/export-reservations.yml`). The workflow requires repository secrets for RecTrac credentials and cloud storage upload.
