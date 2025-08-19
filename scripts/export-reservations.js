// scripts/export-reservations.js
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

/* ========= ENV / S3 (optional) ========= */
const S3_BUCKET  = process.env.S3_BUCKET || "";
const AWS_REGION = process.env.AWS_REGION || "us-east-1";
const s3 = S3_BUCKET ? new S3Client({ region: AWS_REGION }) : null;

/* ========= CONFIG ========= */
const FAC_TERMS = ["Community Lounge", "Multi-use Pool", "Full A+B"];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;         // ...#/login
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL; // deep link to Facility Reservation Interface
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ========= TIMEOUTS ========= */
const NAV_TIMEOUT = 120_000;
const OP_TIMEOUT  = 90_000;

/* ========= Helpers ========= */
const addDays = (d, days) => { const x = new Date(d); x.setDate(x.getDate() + days); return x; };
const fmtUS = (d) => {
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${mm}/${dd}/${d.getFullYear()}`;
};

const parseCsv = (text) => {
  const rows = []; let i = 0, f = "", q = false, row = [];
  while (i < text.length) {
    const c = text[i++];
    if (q) { if (c === '"') { if (text[i] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ",") { row.push(f); f = ""; }
    else if (c === "\n") { row.push(f); rows.push(row); row = []; f = ""; }
    else if (c !== "\r") f += c;
  }
  if (f.length || row.length) { row.push(f); rows.push(row); }
  return rows;
};

const toCsv = (rows) => {
  const headers = Object.keys(rows[0] || { facClass:"", facLocation:"", facCode:"", facShortDesc:"", status:"" });
  const esc = v => `"${String(v ?? "").replaceAll('"','""')}"`;
  return [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
};

const filterDownloadedCsv = (csvText) => {
  const rows = parseCsv(csvText);
  if (!rows.length) return [];
  const headers = rows[0];

  // Try to locate expected columns regardless of exact header captioning
  const idxShort = headers.findIndex(h => /fac.*short.*desc/i.test(h));
  const idxClass = headers.findIndex(h => /fac.*class/i.test(h));
  const idxLoc   = headers.findIndex(h => /fac.*loc/i.test(h));
  const idxCode  = headers.findIndex(h => /fac.*code/i.test(h));
  const idxStat  = headers.findIndex(h => /status/i.test(h));

  if (idxShort < 0) return []; // wrong report selected → we can’t filter

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
};

async function uploadToS3(key, buf) {
  if (!s3 || !S3_BUCKET) return;
  await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET, Key: key, Body: buf,
    ContentType: "text/csv", CacheControl: "no-cache",
  }));
  console.log(`→ Uploaded to s3://${S3_BUCKET}/${key}`);
}

async function saveArtifacts(page, label) {
  try {
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), "utf8");
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), "utf8");
  } catch {}
}

async function reliableGoto(page, url, tag) {
  for (let i = 1; i <= 3; i++) {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }); return; }
    catch (e) { await saveArtifacts(page, `${tag}-goto-${i}`); if (i === 3) throw e; await page.waitForTimeout(800); }
  }
}

async function login(page) {
  await reliableGoto(page, LOGIN_URL, "login");
  const userSel = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
  const passSel = 'input[name="password"], #password, input[type="password"]';
  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In")';

  if (await page.locator(userSel).first().isVisible({ timeout: 20_000 }).catch(() => false)) {
    await page.locator(userSel).first().fill(USERNAME);
    await page.locator(passSel).first().fill(PASSWORD);
    await Promise.all([
      page.waitForLoadState("networkidle").catch(() => {}),
      page.click(submitSel).catch(() => {})
    ]);
  }
}

async function openInterface(page) {
  await reliableGoto(page, GRID_URL, "grid");
  // try likely launchers
  const candidates = [
    page.getByRole("link",   { name: /Facility Reservation Interface/i }),
    page.getByRole("button", { name: /Facility Reservation Interface/i }),
    page.locator('a:has-text("Facility DataGrid")'),
    page.locator('button:has-text("DataGrid")'),
  ];
  for (const c of candidates) {
    const el = c.first();
    if (await el.isVisible({ timeout: 2500 }).catch(() => false)) {
      await el.click().catch(() => {});
      break;
    }
  }
  // Wait for the panel content to be present
  await page.getByText(/Additional Criteria/i).first().waitFor({ state: "visible", timeout: 60_000 });
}

/* ---- Date helpers (robust) ---- */

async function ensureActualMode(root, which /* 'Begin' | 'End' */) {
  const labelRx = new RegExp(`^${which}\\s*Date$`, "i");
  const container = root.locator("div").filter({ has: root.locator("label").filter({ hasText: labelRx }) }).first();

  // Button that toggles the mode ("Actual Date", "Today", etc.)
  const modeBtn = container.locator('button.ui-datetime-date-option, button').first();
  if (await modeBtn.isVisible({ timeout: 1500 }).catch(() => false)) {
    const txt = (await modeBtn.textContent().catch(() => "")).toLowerCase();
    if (!txt.includes("actual")) {
      await modeBtn.click().catch(() => {});
      const menu = root.locator('ul.ui-menu[aria-hidden="false"], ul.ui-menu:visible').last();
      if (await menu.isVisible({ timeout: 2000 }).catch(() => false)) {
        const item = menu.getByRole("menuitem", { name: /Actual Date/i }).first();
        if (await item.isVisible({ timeout: 1000 }).catch(() => false)) await item.click().catch(() => {});
      }
    }
  }
}

async function setDateByLabel(root, which /* 'Begin' | 'End' */, dateObj) {
  const labelRx = new RegExp(`^${which}\\s*Date$`, "i");
  const container = root.locator("div").filter({ has: root.locator("label").filter({ hasText: labelRx }) }).first();

  // Prefer the visible date input within the date wrapper
  const candidates = [
    container.locator(".ui-datetime-date-wrapper input").first(),
    container.locator('input[aria-label*="date" i]').first(),
    container.locator('input[placeholder*="/" i]').first(),
    container.locator('input[type="text"]:not([readonly])').first(),
    // fallback: first non-hidden input after the label
    root.locator(`xpath=//label[normalize-space()="${which} Date"]/following::input[not(@type="hidden")][1]`).first(),
  ];

  let input = null;
  for (const c of candidates) {
    if (await c.isVisible({ timeout: 1200 }).catch(() => false)) { input = c; break; }
  }
  if (!input) throw new Error(`Could not locate visible input for ${which} Date`);

  await input.scrollIntoViewIfNeeded().catch(() => {});
  await input.click({ delay: 40 }).catch(() => {});
  await input.fill(fmtUS(dateObj));
  await input.blur().catch(() => {});
  const val = await input.inputValue().catch(() => "");
  if (!val) throw new Error(`Failed to set ${which} Date`);
  console.log(`→ ${which} Date set to ${val}`);
}

async function setReservationStatusAll(root) {
  // Try underlying <select> first (most reliable)
  const container = root.locator("div").filter({ has: root.locator('label:has-text("Reservation Status")') }).first();
  const select = container.locator("select").first();
  if (await select.isVisible({ timeout: 1000 }).catch(() => false)) {
    try {
      const handle = await select.elementHandle();
      await root.evaluate((el) => {
        for (const opt of el.options) opt.selected = true;
        el.dispatchEvent(new Event("change", { bubbles: true }));
      }, handle);
      console.log("→ Reservation Status = All (via <select>)");
      return;
    } catch {}
  }

  // Fallback: open multiselect and check all boxes
  const btn = container.locator("button").first();
  if (await btn.isVisible({ timeout: 1000 }).catch(() => false)) {
    await btn.click().catch(() => {});
    const menu = root.locator('.ui-multiselect-menu:visible, .ui-multiselect-checkboxes:visible').first();

    const checkAll = root.locator('a:has-text("Check All"), button:has-text("Check All"), a:has-text("Select All"), button:has-text("Select All")').first();
    if (await checkAll.isVisible({ timeout: 1000 }).catch(() => false)) {
      await checkAll.click().catch(() => {});
    } else {
      const boxes = menu.locator('input[type="checkbox"]');
      const n = await boxes.count().catch(() => 0);
      for (let i = 0; i < n; i++) { try { await boxes.nth(i).check({ force: true }); } catch {} }
    }
    // close menu
    await root.keyboard.press("Escape").catch(() => {});
    console.log("→ Reservation Status = All (via multiselect)");
  }
}

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
    await login(page);

    console.log("→ Opening Facility Reservation Interface…");
    await openInterface(page);

    // Prepare fields BEFORE clicking Process
    console.log("→ Setting date range (today .. +13 days), and making sure filters are sane…");
    const today = new Date();

    await ensureActualMode(page, "Begin");
    await ensureActualMode(page, "End");

    await setDateByLabel(page, "Begin", today);
    await setDateByLabel(page, "End", addDays(today, 13));

    await setReservationStatusAll(page);

    // Export file name for clarity in the notification center
    const exportName = page.locator('label:has-text("Export File Name")')
      .locator("xpath=following-sibling::*//input").first();
    if (await exportName.isVisible({ timeout: 1000 }).catch(() => false)) {
      await exportName.fill("gmcc-week.csv").catch(() => {});
    }

    await saveArtifacts(page, "dates-confirm"); // visual proof pre-Process

    // Run the export
    console.log("→ Clicking Process…");
    const processBtn = page.getByRole("button", { name: /^Process$/i }).first();
    await processBtn.click();

    // Close the “Success / Check notification center” dialog
    const ok = page.locator('.ui-dialog button:has-text("Close"), .ui-dialog button:has-text("OK")').first();
    if (await ok.isVisible({ timeout: 15_000 }).catch(() => false)) await ok.click().catch(() => {});

    // Open Notification Center and click “Preview Document”
    console.log("→ Opening Notification Center …");
    let download = null;

    const tryPreview = async () => {
      const preview = page.locator('button:has-text("Preview Document"), a:has-text("Preview Document")').first();
      if (await preview.isVisible({ timeout: 1500 }).catch(() => false)) {
        const dl = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
        await preview.click().catch(() => {});
        return await dl;
      }
      return null;
    };

    // tap a few likely sidebar buttons until a preview appears
    const sidebarButtons = page.locator("aside button, nav button, .sidebar button");
    const count = await sidebarButtons.count();
    for (let i = 0; i < Math.min(count, 8) && !download; i++) {
      await sidebarButtons.nth(i).click().catch(() => {});
      download = await tryPreview();
    }
    if (!download) {
      // Fallback: any CSV link in the panel
      const maybe = page.locator('a[href*=".csv"]').first();
      if (await maybe.isVisible({ timeout: 2000 }).catch(() => false)) {
        const dl = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
        await maybe.click().catch(() => {});
        download = await dl;
      }
    }
    if (!download) throw new Error("Could not obtain the export from the notification center.");

    // Persist raw CSV
    let tmp = await download.path();
    if (!tmp) {
      tmp = path.resolve(download.suggestedFilename() || "rectrac-export.csv");
      await download.saveAs(tmp);
    }

    const rawText = fs.readFileSync(tmp, "utf8");
    const rawOut = path.resolve("gmcc-week-raw.csv");
    fs.writeFileSync(rawOut, rawText, "utf8");
    console.log(`→ Saved raw export to ${rawOut}`);
    console.log(`→ Raw export rows (including header): ${parseCsv(rawText).length}`);

    // Filter + save filtered CSV
    console.log("→ Filtering locally to target facilities …");
    const filtered = filterDownloadedCsv(rawText);
    const filteredText = filtered.length
      ? toCsv(filtered)
      : (toCsv([{ facClass:"", facLocation:"", facCode:"", facShortDesc:"", status:"" }]).trim() + "\n");

    const outPath = path.resolve("gmcc-week.csv");
    fs.writeFileSync(outPath, filteredText, "utf8");
    console.log(`→ Wrote ${filtered.length} matching rows to ${outPath}`);

    // Optional S3 publish (useful for Vercel to fetch a durable URL)
    if (S3_BUCKET) {
      await uploadToS3("gmcc-week-raw.csv", Buffer.from(rawText, "utf8"));
      await uploadToS3("gmcc-week.csv", Buffer.from(filteredText, "utf8"));
    }
  } catch (err) {
    console.error("✖ Run failed:", err);
    await saveArtifacts(page, "error");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();
