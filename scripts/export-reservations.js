// scripts/export-reservations.js
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/* ======== ENV / S3 ======== */
const S3_BUCKET = process.env.S3_BUCKET || "";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const s3 = new S3Client({ region: AWS_REGION });

/* ======== CONFIG ======== */
const FAC_TERMS = ["Community Lounge", "Multi-use Pool", "Full A+B"];

// Required
const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;          // …#/login
// Optional deep link to the facility panel
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL || "";

const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ======== TIMEOUTS ======== */
const NAV_TIMEOUT = 120_000;
const OP_TIMEOUT  = 90_000;
const LONG_WAIT   = 30_000;

/* ======== UTIL ======== */

async function uploadBufferToS3(buf, key, contentType = "text/plain") {
  if (!S3_BUCKET) return; // optional
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buf,
    ContentType: contentType,
    CacheControl: "no-cache",
  }));
  console.log(`→ Uploaded to s3://${S3_BUCKET}/${key}`);
}

async function uploadFileToS3(localPath, key, fallbackCT = "text/plain") {
  if (!S3_BUCKET) return;
  const buf = fs.readFileSync(localPath);
  // crude CT guess
  const ct = localPath.endsWith(".csv") ? "text/csv" :
             localPath.endsWith(".pdf") ? "application/pdf" :
             localPath.endsWith(".txt") ? "text/plain" : fallbackCT;
  await uploadBufferToS3(buf, key, ct);
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

/* ======== CSV helpers (filter) ======== */
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

/* ======== Login / Nav ======== */
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

    if (!page.url().includes('#/login')) break;

    const userField = page.locator(userSel).first();
    const hasLogin = await userField.isVisible({ timeout: 5000 }).catch(() => false);
    if (hasLogin) {
      await userField.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.click(submitSel).catch(() => {})
      ]);
      continue;
    }
    await page.waitForTimeout(800);
  }

  if (page.url().includes('#/login')) {
    await saveFailureArtifacts(page, 'login-stuck');
    throw new Error('Login did not complete.');
  }
}

async function openFacilityPanel(context, page) {
  if (GRID_URL) {
    await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' }).catch(() => {});
  }
  await clickIfResumePrompt(page);
  for (const f of page.frames()) await clickIfResumePrompt(f);

  // Pre-arm for possible popup
  const waitPopup = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);

  // Try common launchers
  const candidates = [
    page.getByRole('button', { name: /data\s*grid/i }),
    page.getByRole('link', { name: /facility reservation interface/i }),
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
    await popup.waitForLoadState('domcontentloaded');
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
    page.getByRole('button', { name: /data\s*grid/i }),
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

/* ======== Date helpers ======== */
function addDays(d, days) { const x = new Date(d); x.setDate(x.getDate() + days); return x; }
function formatUS(d) {
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${mm}/${dd}/${d.getFullYear()}`;
}

// Click the small left-hand mode button and pick "Actual Date" if needed,
// then fill the text input next to it.
async function setActualDate(root, fieldLabel, dateObj) {
  const container = root.locator('div').filter({
    has: root.locator(`label:has-text("${fieldLabel}")`)
  }).first();

  const trigger = container.locator('button.ui-datetime-date-option, button').first();
  const current = (await trigger.textContent().catch(() => '') || '').toLowerCase();
  if (!current.includes('actual')) {
    await trigger.click().catch(() => {});
    const menu = root.locator('ul.ui-menu[aria-hidden="false"]').last();
    if (await menu.isVisible({ timeout: 1500 }).catch(() => false)) {
      const item = menu.getByRole('menuitem', { name: /Actual Date/i }).first();
      if (await item.isVisible().catch(() => false)) await item.click().catch(() => {});
    }
    await (root.page ? root.page() : root).keyboard.press('Escape').catch(() => {});
  }

  // Fill the input
  const candidates = [
    container.locator('input[aria-label*="date" i]').first(),
    container.locator('input[placeholder*="/" i]').first(),
    container.locator('input[type="text"]').last(),
    container.locator('input').last(),
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
    // Read back
    const readBack = (await input.inputValue().catch(() => "")) || "";
    console.log(`→ End Date input now shows: "${readBack}"`);
  } else {
    console.log(`→ Could not locate input for ${fieldLabel}`);
  }
}

async function chooseRelativeToday(root, fieldLabel) {
  const container = root.locator('div').filter({
    has: root.locator(`label:has-text("${fieldLabel}")`)
  }).first();

  // Mode button -> choose "Today"
  const trigger = container.locator('button.ui-datetime-date-option, button').first();
  await trigger.click({ force: true }).catch(() => {});
  let menu = root.locator('ul.ui-menu[aria-hidden="false"]').first();
  if (await menu.isVisible({ timeout: 800 }).catch(() => false)) {
    const item = menu.getByRole('menuitem', { name: /^Today$/i }).first();
    await item.click().catch(() => {});
  } else {
    // fallback: just ensure blurs
    await (root.page ? root.page() : root).keyboard.press('Escape').catch(() => {});
  }

  // There is usually a small numeric offset next to "Today"
  const offset = container.locator('input[type="number"], input[aria-label*="offset" i]').first();
  if (await offset.isVisible({ timeout: 500 }).catch(() => false)) {
    await offset.fill("0").catch(() => {});
    await offset.blur().catch(() => {});
    const readBack = (await offset.inputValue().catch(() => "")) || "";
    console.log(`→ Begin Date offset now shows: "${readBack}"`);
  }
}

async function setDateRanges(root) {
  console.log("→ Setting date range …");
  await chooseRelativeToday(root, "Begin Date");
  await setActualDate(root, "End Date", addDays(new Date(), 13));

  // Focused screenshot of the Additional Criteria block for verification
  const crit = root.getByText(/Additional Criteria/i).locator("..");
  try {
    await crit.scrollIntoViewIfNeeded().catch(() => {});
    const page = root.page ? root.page() : root;
    await page.screenshot({ path: "playwright-dates-confirm.png", fullPage: false });
  } catch {}
}

/* ======== Export ======== */
async function findGridRoot(page) {
  const headerTexts = [/Facility Reservation Interface/i, /Facility DataGrid/i, /Facilities/i];

  const tryRoot = async (root) => {
    await waitOutSpinner(root);
    await clickIfResumePrompt(root);
    for (const rx of headerTexts) {
      if (await root.getByText(rx).first().isVisible({ timeout: 800 }).catch(() => false)) return root;
    }
    if (await root.locator('table').first().isVisible({ timeout: 800 }).catch(() => false)) return root;
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

async function clickProcess(root) {
  const btn = root.locator('button:has-text("Process"), input[type="button"][value="Process"], input[type="submit"][value="Process"]').first();
  await btn.scrollIntoViewIfNeeded().catch(() => {});
  await btn.click({ timeout: 6_000 }).catch(() => {});
  await waitOutSpinner(root);

  // close any “Success / sent to server” dialog
  const closeBtn = root.locator('.ui-dialog button:has-text("Close"), .ui-dialog .ui-dialog-titlebar-close, [role="dialog"] button:has-text("OK")').first();
  if (await closeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    await closeBtn.click().catch(() => {});
  }
}

async function openNotificationCenter(page) {
  // Try several likely sidebar buttons
  const guesses = [
    'button[aria-label*="Notification" i]',
    'button[title*="Notification" i]',
    'button[class*="notification" i]',
    '.sidebar button:has(svg)',
    'aside button', 'nav button'
  ];
  for (const sel of guesses) {
    const cand = page.locator(sel).first();
    if (await cand.isVisible({ timeout: 1000 }).catch(() => false)) {
      await cand.click().catch(() => {});
      await page.waitForTimeout(800);
      break;
    }
  }

  // Look for the panel and the latest FacilityReservationInterface entry
  const panel = page.locator('div:has-text("Notifications"), .notification-panel, .notifications-dropdown').first();
  if (!(await panel.isVisible({ timeout: 4000 }).catch(() => false))) return null;

  const latest = panel.locator('div:has-text("FacilityReservationInterface"), div:has-text("Process is Complete")').first();
  if (!(await latest.isVisible({ timeout: 2000 }).catch(() => false))) return null;

  // Prefer a “Preview Document” button
  let preview = latest.locator('button:has-text("Preview Document"), a:has-text("Preview Document")').first();
  if (!(await preview.isVisible({ timeout: 1000 }).catch(() => false))) {
    await latest.click().catch(() => {});
    await page.waitForTimeout(500);
    preview = page.locator('button:has-text("Preview Document"), a:has-text("Preview Document")').first();
  }
  if (await preview.isVisible({ timeout: 2000 }).catch(() => false)) {
    const downloadPromise = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
    await preview.click().catch(() => {});
    return await downloadPromise;
  }
  return null;
}

async function processExport(root, page) {
  console.log("→ Preparing export …");
  // 1) Dates first
  await setDateRanges(root);

  // 2) Now click Process
  console.log("→ Clicking Process …");
  await clickProcess(root);

  // 3) Get the file via Notification Center
  console.log("→ Opening Notification Center …");
  const download = await openNotificationCenter(page);
  if (!download) throw new Error("Could not retrieve the exported document from Notification Center.");
  return download;
}

/* ======== MAIN ======== */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: "en-US",
    timezoneId: "America/Detroit",
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  context.setDefaultTimeout(OP_TIMEOUT);

  const page = await context.newPage();

  try {
    console.log("→ Logging in…");
    await fullyLogin(page);

    console.log("→ Opening Facility Reservation Interface …");
    const workPage = await openFacilityPanel(context, page);

    console.log("→ Opening Facility DataGrid…");
    await openFacilityDataGrid(workPage);

    console.log("→ Locating Facility DataGrid …");
    const root = await findGridRoot(workPage);
    if (!root) {
      await saveFailureArtifacts(workPage, 'no-grid');
      throw new Error('Could not find the Facilities grid.');
    }

    console.log("→ Processing export …");
    const download = await processExport(root, workPage);

    // Save raw exactly as delivered
    let suggested = download.suggestedFilename() || "rectrac-export";
    if (!/\.[a-z0-9]{2,5}$/i.test(suggested)) suggested += ".csv";
    const rawPath = path.resolve(`gmcc-week-raw${path.extname(suggested) ? path.extname(suggested) : ".csv"}`);
    await download.saveAs(rawPath);
    console.log(`→ Saved raw export to ${rawPath}`);

    // Read and log some stats
    const rawText = fs.readFileSync(rawPath, "utf8");
    const rows = parseCsv(rawText);
    const header = rows[0] ? rows[0].join(",") : "";
    console.log(`→ Export headers: ${header}`);
    console.log(`→ Raw export rows (including header): ${rows.length}`);

    // Produce filtered CSV for the GMCC calendar
    const filtered = filterDownloadedCsv(rawText);
    const filteredPath = path.resolve("gmcc-week.csv");
    if (filtered.length) {
      fs.writeFileSync(filteredPath, toCsv(filtered), "utf8");
      console.log(`→ Wrote ${filtered.length} matching rows to ${filteredPath}`);
    } else {
      fs.writeFileSync(
        filteredPath,
        toCsv([{ facClass:"", facLocation:"", facCode:"", facShortDesc:"", status:"" }]).trim() + "\n",
        "utf8"
      );
      console.log(`→ Wrote 0 matching rows to ${filteredPath}`);
    }

    // Upload both (optional but recommended for Vercel)
    await uploadFileToS3(rawPath, "gmcc-week-raw.csv", "text/csv");
    await uploadFileToS3(filteredPath, "gmcc-week.csv", "text/csv");

  } catch (err) {
    console.error("Scrape failed:", err);
    await saveFailureArtifacts(page, "error");
    process.exit(1);
  } finally {
    await browser.close();
  }
})();