// scripts/export-reservations.js
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/* ========= ENV / AWS ========= */
const S3_BUCKET = process.env.S3_BUCKET;
const AWS_REGION = process.env.AWS_REGION;
const s3 = new S3Client({ region: AWS_REGION });

/* ========= CONFIG ========= */
const FAC_TERMS = ["Community Lounge", "Multi-use Pool", "Full A+B"];

// Required
const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;     // ...#/login
// Optional: a deep link that *sometimes* loads a blank panel. We'll still try it first.
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL || "";

const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ========= TIMEOUTS ========= */
const NAV_TIMEOUT = 120_000; // first paint / route changes
const OP_TIMEOUT  = 90_000;  // general UI ops
const LONG_WAIT   = 30_000;

/* ========= UTIL ========= */

async function uploadCsvBufferToS3(buf, key = "gmcc-week.csv") {
  if (!S3_BUCKET) return; // optional
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buf,
    ContentType: "text/csv",
    CacheControl: "no-cache",
  }));
  console.log(`→ Uploaded to s3://${S3_BUCKET}/${key}`);
}

async function nukeOverlays(page) {
  const roots = [page, ...page.frames()];
  for (const r of roots) {
    try { await r.keyboard.press("Escape"); } catch {}
    try {
      await r.locator(
        '.ui-dialog .ui-dialog-titlebar-close, .ui-dialog button:has-text("Close"), [role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("OK")'
      ).first().click({ timeout: 1000 });
    } catch {}
    try {
      await r.evaluate(() => {
        document.querySelectorAll('.ui-widget-overlay, .ui-widget-overlay.skipwidget')
          .forEach(el => el.remove());
      });
    } catch {}
  }
}

async function saveFailureArtifacts(pageLike, label) {
  const page = pageLike.page ? pageLike.page() : pageLike;
  try {
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), "utf8");
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), "utf8");
  } catch {}
}

async function waitOutSpinner(root) {
  const spinner = root.locator('text=/Please\\s+Wait/i').first();
  if (await spinner.isVisible({ timeout: 800 }).catch(() => false)) {
    await spinner.waitFor({ state: "detached", timeout: LONG_WAIT }).catch(() => {});
  }
}

async function clickIfResumePrompt(root) {
  const prompt = root.getByText(/Login Prompts/i).first();
  if (await prompt.isVisible({ timeout: 800 }).catch(() => false)) {
    await root.getByRole("button", { name: /continue/i }).click({ timeout: 8_000 }).catch(() => {});
    await root.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await root.waitForTimeout(600);
  }
}

/* ---- Date helpers ---- */
function addDays(d, days) { const x = new Date(d); x.setDate(x.getDate() + days); return x; }
function formatUS(d) {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
}

// Select a relative option like "Today" from the jQuery-UI date menu.
// Falls back to typing today's date if the menu doesn't appear.
async function chooseRelativeDate(root, fieldLabel, optionText) {
  const container = root.locator("div").filter({
    has: root.locator(`label:has-text("${fieldLabel}")`)
  }).first();

  const trigger = container.locator('button.ui-datetime-date-option, button:has-text("Actual Date")').first();
  await trigger.scrollIntoViewIfNeeded().catch(() => {});
  await trigger.click({ force: true });

  let menu = root.locator('ul.ui-menu[aria-hidden="false"], ul.ui-menu:visible').first();
  if (!(await menu.isVisible({ timeout: 400 }).catch(() => false))) {
    const page = root.page ? root.page() : null;
    const scopes = page ? [page, ...page.frames()] : [];
    for (const s of scopes) {
      const m = s.locator('ul.ui-menu[aria-hidden="false"], ul.ui-menu:visible').first();
      if (await m.isVisible({ timeout: 150 }).catch(() => false)) { menu = m; break; }
    }
  }

  if (await menu.isVisible({ timeout: 150 }).catch(() => false)) {
    let item = menu.getByRole("menuitem", { name: new RegExp(`^${optionText}$`, "i") }).first();
    if (!(await item.isVisible().catch(() => false))) {
      item = menu.locator('li[role="menuitem"], .ui-menu-item')
                 .filter({ hasText: new RegExp(`^${optionText}$`, "i") }).first();
    }
    await item.click().catch(() => {});
    await (root.page ? root.page() : root).keyboard.press("Escape").catch(() => {});
    await root.waitForTimeout(120);
    return;
  }

  // Fallback: type today's date
  const input = container.locator('input[type="text"], input').first();
  const todayText = formatUS(new Date());
  await input.fill(todayText);
  await input.dispatchEvent("input").catch(() => {});
  await input.dispatchEvent("change").catch(() => {});
  await input.blur().catch(() => {});
  await root.waitForTimeout(120);
}

// Force a field's mode to "Actual Date" and fill its text box.
async function setActualDate(root, fieldLabel, dateObj) {
  const container = root.locator("div").filter({
    has: root.locator(`label:has-text("${fieldLabel}")`)
  }).first();

  const trigger = container.locator("button.ui-datetime-date-option, button").first();
  const current = (await trigger.textContent().catch(() => "") || "").toLowerCase();
  if (!current.includes("actual")) {
    await trigger.click().catch(() => {});
    const menu = root.locator('ul.ui-menu[aria-hidden="false"]').last();
    if (await menu.isVisible({ timeout: 1500 }).catch(() => false)) {
      const item = menu.getByRole("menuitem", { name: /Actual Date/i }).first();
      if (await item.isVisible().catch(() => false)) await item.click().catch(() => {});
    }
    await (root.page ? root.page() : root).keyboard.press("Escape").catch(() => {});
  }

  // Fill the date input near the trigger
  const candidates = [
    container.locator('input[aria-label*="date" i]').first(),
    container.locator('input[placeholder*="/" i]').first(),
    container.locator('input[type="text"]').last(),
    container.locator("input").last(),
  ];
  let input = null;
  for (const c of candidates) {
    if (await c.isVisible({ timeout: 500 }).catch(() => false)) { input = c; break; }
  }
  if (input) {
    const value = formatUS(dateObj);
    await input.click().catch(() => {});
    await input.fill(value).catch(() => {});
    await input.blur().catch(() => {});
    console.log(`→ Set ${fieldLabel} to Actual Date ${value}`);
  } else {
    console.log(`→ Could not locate input for ${fieldLabel}`);
  }
}

// If there's a numeric offset for "Begin Date = Today", ensure it's 0.
async function ensureBeginOffsetZero(root, fieldLabel = "Begin Date") {
  const container = root.locator("div").filter({
    has: root.locator(`label:has-text("${fieldLabel}")`)
  }).first();

  const offset = container.locator('input[type="number"], input[aria-label*="offset" i]').first();
  if (await offset.isVisible({ timeout: 500 }).catch(() => false)) {
    await offset.fill("0").catch(() => {});
    await offset.blur().catch(() => {});
  }
}

async function setDateRanges(root) {
  console.log("→ Setting date range: Begin = Today (0), End = Actual Date (today + 13) …");
  try { await (root.page ? root.page() : root).keyboard.press("Escape"); } catch {}

  await chooseRelativeDate(root, "Begin Date", "Today").catch(() => {});
  await ensureBeginOffsetZero(root).catch(() => {});
  await setActualDate(root, "End Date", addDays(new Date(), 13)); // 2 weeks inclusive

  await saveFailureArtifacts(root.page ? root.page() : root, "dates-after-set");
  await root.waitForTimeout(300);
}

/* ---- CSV helpers ---- */
function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", inQ = false, row = [];
  while (i < text.length) {
    const c = text[i++];
    if (inQ) {
      if (c === '"') {
        if (text[i] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsv(rows) {
  const headers = Object.keys(rows[0] || { facClass:"", facLocation:"", facCode:"", facShortDesc:"", status:"" });
  const esc = v => `"${String(v ?? "").replaceAll('"','""')}"`;
  return [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
}

function filterDownloadedCsv(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return [];

  const headers = rows[0];
  const idxShort = headers.findIndex(h => /fac.*short.*desc/i.test(h));
  const idxClass = headers.findIndex(h => /fac.*class/i.test(h));
  const idxLoc   = headers.findIndex(h => /fac.*loc/i.test(h));
  const idxCode  = headers.findIndex(h => /fac.*code/i.test(h));
  const idxStat  = headers.findIndex(h => /status/i.test(h));

  const wanted = FAC_TERMS.map(s => s.toLowerCase());
  const out = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const short = (row[idxShort] || "").toLowerCase();
    if (wanted.some(t => short.includes(t))) {
      out.push({
        facClass:     row[idxClass] ?? "",
        facLocation:  row[idxLoc]   ?? "",
        facCode:      row[idxCode]  ?? "",
        facShortDesc: row[idxShort] ?? "",
        status:       row[idxStat]  ?? ""
      });
    }
  }
  return out;
}

/* ========= LOGIN / NAV ========= */
async function gotoWithRetries(page, url, label) {
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: NAV_TIMEOUT });
      await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      return;
    } catch (e) {
      await saveFailureArtifacts(page, `${label}-goto-${i}`);
      if (i === 3) throw e;
      await page.waitForTimeout(1500);
    }
  }
}

async function fullyLogin(page) {
  const userSel = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
  const passSel = 'input[name="password"], #password, input[type="password"]';
  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In")';

  await gotoWithRetries(page, LOGIN_URL, "login");

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);

    if (!page.url().includes("#/login")) break;

    const userField = page.locator(userSel).first();
    const hasLogin = await userField.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasLogin) {
      await userField.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState("networkidle").catch(() => {}),
        page.click(submitSel).catch(() => {})
      ]);
      continue;
    }
    await page.waitForTimeout(800);
  }

  if (page.url().includes("#/login")) {
    await saveFailureArtifacts(page, "login-stuck");
    throw new Error("Login did not complete.");
  }
}

async function openFacilityPanel(context, page) {
  await page.goto(GRID_URL, { waitUntil: "domcontentloaded" });

  await clickIfResumePrompt(page);
  for (const f of page.frames()) await clickIfResumePrompt(f);

  const waitPopup = context.waitForEvent("page", { timeout: 15000 }).catch(() => null);

  const candidates = [
    page.getByRole("button", { name: /data\s*grid/i }),
    page.getByRole("link", { name: /facility reservation interface/i }),
    page.locator('a:has-text("Facility DataGrid")'),
    page.locator('button:has-text("DataGrid")'),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      await el.click().catch(() => {});
      break;
    }
  }

  const popup = await waitPopup;
  if (popup) {
    await popup.waitForLoadState("domcontentloaded");
    await clickIfResumePrompt(popup);
    return popup;
  }
  return page;
}

async function openFacilityDataGrid(page) {
  await waitOutSpinner(page);
  await clickIfResumePrompt(page);

  if (await page.getByText(/Facility DataGrid/i).first().isVisible({ timeout: 1000 }).catch(() => false)) return;

  const candidates = [
    page.getByRole("button", { name: /data\s*grid/i }),
    page.locator('[title*="Data Grid" i]'),
    page.locator('[title*="DataGrid" i]'),
    page.locator('a:has-text("Facility DataGrid")'),
    page.locator('button:has-text("DataGrid")'),
    page.locator('div.v-tooltip:has-text("DataGrid")'),
  ];
  for (const loc of candidates) {
    const el = loc.first();
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      await el.click().catch(() => {});
      await waitOutSpinner(page);
      break;
    }
  }
}

/* ========= GRID DETECTION / EXPORT ========= */
async function findGridRoot(page) {
  const headerTexts = [/Facility Reservation Interface/i, /Facility DataGrid/i, /Facilities/i];

  const tryRoot = async (root) => {
    await waitOutSpinner(root);
    await clickIfResumePrompt(root);
    for (const rx of headerTexts) {
      if (await root.getByText(rx).first().isVisible({ timeout: 800 }).catch(() => false)) return root;
    }
    if (await root.locator("table").first().isVisible({ timeout: 800 }).catch(() => false)) return root;
    return null;
  };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let r = await tryRoot(page);
    if (r) return r;
    for (const f of page.frames()) {
      r = await tryRoot(f);
      if (r) return r;
    }
    await page.waitForTimeout(700);
  }
  return null;
}

async function processExport(root) {
  console.log("→ Preparing export …");
  await setDateRanges(root);

  // quick snapshot before clicking Process
  await saveFailureArtifacts(root.page ? root.page() : root, "before-process-button");

  // Click a visible Process button
  const processBtn = root.locator([
    'button:has-text("Process")',
    'input[type="button"][value="Process"]',
    'input[type="submit"][value="Process"]',
    'button[value="Process"]'
  ].join(", ")).first();

  if (!(await processBtn.isVisible({ timeout: 5000 }).catch(() => false))) {
    await saveFailureArtifacts(root.page ? root.page() : root, "no-process-button");
    throw new Error("Could not find the Process button.");
  }

  await processBtn.click().catch(() => {});
  await root.waitForTimeout(2000);

  // Close any "Success / Process sent / Complete" dialog if present
  const closeCandidates = [
    root.locator('.ui-dialog button:has-text("Close")'),
    root.locator('.ui-dialog button:has-text("OK")'),
    root.locator(".ui-dialog .ui-dialog-titlebar-close")
  ];
  for (const c of closeCandidates) {
    if (await c.isVisible({ timeout: 1000 }).catch(() => false)) {
      await c.click({ timeout: 2000 }).catch(() => {});
      break;
    }
  }
}

/* === Notification Center download === */
async function accessNotificationCenter(page) {
  console.log("→ Opening Notification Center …");

  // Try a handful of bell-like/notification selectors
  const selectors = [
    'button[aria-label*="Notification" i]',
    'button[title*="Notification" i]',
    'button[class*="notification" i]',
    '.sidebar button:has(svg)',
    'aside button, nav button, .sidebar button'
  ];

  let bell = null;
  for (const sel of selectors) {
    const cand = page.locator(sel).first();
    if (await cand.isVisible({ timeout: 1200 }).catch(() => false)) { bell = cand; break; }
  }
  if (!bell) { console.log("→ Could not find notification button"); return null; }

  await bell.click().catch(() => {});
  await page.waitForTimeout(1500);

  // Find a "FacilityReservationInterface" item with "Preview Document"
  const panel = page.locator('div:has-text("Notifications"), .notification-panel, .notifications-dropdown, [class*="notification"][class*="panel"]').first();
  if (!(await panel.isVisible({ timeout: 4000 }).catch(() => false))) return null;

  const entry = panel.locator('div:has-text("FacilityReservationInterface"), div:has-text("Process is Complete")').first();
  if (!(await entry.isVisible({ timeout: 2000 }).catch(() => false))) return null;

  let preview = entry.locator('button:has-text("Preview Document"), a:has-text("Preview Document")').first();
  if (!(await preview.isVisible({ timeout: 2000 }).catch(() => false))) {
    await entry.click().catch(() => {});
    await page.waitForTimeout(700);
    preview = page.locator('button:has-text("Preview Document"), a:has-text("Preview Document")').first();
  }

  if (await preview.isVisible({ timeout: 2000 }).catch(() => false)) {
    const dl = page.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
    await preview.click().catch(() => {});
    const download = await dl;
    if (download) {
      console.log("→ Download started from Notification Center");
      return download;
    }
  }
  return null;
}

/* ========= MAIN ========= */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: "en-US",
    timezoneId: "America/Detroit",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  context.setDefaultTimeout(OP_TIMEOUT);

  const page = await context.newPage();

  try {
    // 1) Login
    console.log("→ Logging in…");
    await fullyLogin(page);

    // 2) Open the Facility panel (captures popup if RecTrac opens a legacy window)
    console.log("→ Opening Facility Reservation Interface …");
    const workPage = await openFacilityPanel(context, page);

    // 3) If there is a left-toolbar DataGrid tool, click it
    console.log("→ Opening Facility DataGrid…");
    await openFacilityDataGrid(workPage);

    // 4) Find the grid root (page or iframe)
    console.log("→ Locating Facility DataGrid …");
    const root = await findGridRoot(workPage);
    if (!root) {
      await saveFailureArtifacts(workPage, "no-grid");
      throw new Error("Could not find the Facilities grid. (Panel loaded but DataGrid never appeared.)");
    }

    // 5) Kick off export and fetch the finished document via Notification Center
    console.log("→ Processing export …");
    await processExport(root);
    await nukeOverlays(workPage);

    let download = await accessNotificationCenter(workPage);
    if (!download) {
      await saveFailureArtifacts(workPage, "no-download");
      throw new Error("Export finished but no download was captured from the Notification Center.");
    }

    // Read exported CSV
    let tmpPath = await download.path();
    if (!tmpPath) {
      const alt = path.resolve(`./${download.suggestedFilename() || "rectrac-export.csv"}`);
      await download.saveAs(alt);
      tmpPath = alt;
    }
    const csvText = fs.readFileSync(tmpPath, "utf8");

    // Filter down to the facilities we care about
    console.log("→ Filtering locally to target facilities …");
    const filtered = filterDownloadedCsv(csvText);

    const outRows = filtered.length
      ? filtered
      : [{ facClass:"", facLocation:"", facCode:"", facShortDesc:"", status:"" }];

    const outText = toCsv(outRows) + (outRows.length ? "" : "\n");

    // Write to disk
    const outPath = path.resolve("gmcc-week.csv");
    fs.writeFileSync(outPath, outText, "utf8");
    console.log(`→ Wrote ${filtered.length} matching rows to ${outPath}`);

    // Optional: mirror to S3
    await uploadCsvBufferToS3(Buffer.from(outText, "utf8"), "gmcc-week.csv");
  } catch (err) {
    console.error("Scrape failed:", err);
    await saveFailureArtifacts(page, "error");
    process.exit(1);
  } finally {
    await browser.close();
  }
})();