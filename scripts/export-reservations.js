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

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;           // ...#/login
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL;   // deep link to Facility Reservation Interface launcher
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

const NAV_TIMEOUT = 120_000;
const OP_TIMEOUT  = 90_000;

/* ========= small utils ========= */
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
  const idxShort = headers.findIndex(h => /fac.*short.*desc/i.test(h));
  const idxClass = headers.findIndex(h => /fac.*class/i.test(h));
  const idxLoc   = headers.findIndex(h => /fac.*loc/i.test(h));
  const idxCode  = headers.findIndex(h => /fac.*code/i.test(h));
  const idxStat  = headers.findIndex(h => /status/i.test(h));
  if (idxShort < 0) return []; // wrong report → nothing to filter

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
    ContentType: "text/csv", CacheControl: "no-cache"
  }));
  console.log(`→ Uploaded to s3://${S3_BUCKET}/${key}`);
}

/* ========= page helpers ========= */
async function saveArtifacts(page, label) {
  try {
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), "utf8");
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), "utf8");
  } catch {}
}
async function goto(page, url, tag) {
  for (let i = 1; i <= 3; i++) {
    try { await page.goto(url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT }); return; }
    catch (e) { await saveArtifacts(page, `${tag}-goto-${i}`); if (i === 3) throw e; await page.waitForTimeout(800); }
  }
}
async function login(page) {
  await goto(page, LOGIN_URL, "login");
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

/* === robust field setters (work off real DOM seen in artifacts) === */

// Finds the visible date input inside the “Begin Date” / “End Date” field group and fills it.
async function setDateField(root, which /* 'Begin' | 'End' */, dateObj) {
  // locate the label then walk to the date wrapper
  const labelRx = new RegExp(`^${which}\\s*Date$`, "i");
  const container = root.locator("div").filter({ has: root.locator("label").filter({ hasText: labelRx }) }).first();

  // Force the left-hand button to "Actual Date" (usually already is)
  const modeBtn = container.locator("button.ui-datetime-date-option, button").first();
  if (await modeBtn.isVisible().catch(() => false)) {
    const txt = (await modeBtn.textContent().catch(() => "")).toLowerCase();
    if (!txt.includes("actual")) {
      await modeBtn.click().catch(() => {});
      const menu = root.locator('ul.ui-menu[aria-hidden="false"]').last();
      if (await menu.isVisible({ timeout: 1000 }).catch(() => false)) {
        await menu.getByRole("menuitem", { name: /Actual Date/i }).first().click().catch(() => {});
      }
    }
  }

  // Fill the visible input
  const dateInput = container.locator(".ui-datetime-date-wrapper input.ui-datetime-date-input").first();
  await dateInput.scrollIntoViewIfNeeded().catch(() => {});
  await dateInput.click().catch(() => {});
  await dateInput.fill(fmtUS(dateObj));
  await dateInput.blur().catch(() => {});

  // verify
  const val = await dateInput.inputValue().catch(() => "");
  if (!val) throw new Error(`Failed to set ${which} Date`);
  console.log(`→ ${which} Date set to ${val}`);
}

async function setReservationStatusAll(root) {
  // Hidden <select multiple> + visible jQuery UI button with “(0) Selected)”
  const sel = root.locator('select[name="facilityreservationinterface_recordstatus"]').first();
  if (!(await sel.count())) return;

  await root.evaluate((el) => {
    const sel = el;
    for (const opt of sel.options) opt.selected = true;
    sel.dispatchEvent(new Event("change", { bubbles: true }));
  }, await sel.elementHandle());

  // Update the visible label text (optional)
  const btn = sel.locator("xpath=following-sibling::button[1]").first();
  if (await btn.isVisible().catch(() => false)) {
    await btn.evaluate((b) => {
      const txt = b.querySelector(".ui-icon-text");
      if (txt) txt.textContent = "(All)";
    }).catch(() => {});
  }
  console.log("→ Reservation Status = All");
}

async function openExporter(page) {
  // land on the Facility Reservation Interface launcher
  await goto(page, GRID_URL, "panel");
  // try a few likely launchers
  const candidates = [
    page.getByRole("link",   { name: /Facility Reservation Interface/i }),
    page.getByRole("button", { name: /Facility Reservation Interface/i }),
    page.locator('a:has-text("Facility DataGrid")'),
    page.locator('button:has-text("DataGrid")'),
  ];
  for (const c of candidates) {
    if (await c.first().isVisible({ timeout: 2000 }).catch(() => false)) {
      await c.first().click().catch(() => {});
      break;
    }
  }
}

/* ========= MAIN ========= */
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
    await openExporter(page);

    // Use the current page (or an internal frame) as the root for field ops
    const root = page;

    // === PREPARE FIELDS BEFORE CLICKING PROCESS ===
    console.log("→ Setting date range (today .. +13 days), and making sure filters are sane…");
    const today = new Date();
    await setDateField(root, "Begin", today);
    await setDateField(root, "End", addDays(today, 13));
    await setReservationStatusAll(root); // avoids “(0) Selected” = empty results

    // Name the export file (so the notification center shows gmcc-week.csv)
    const exportName = root.locator('label:has-text("Export File Name")')
      .locator("xpath=following-sibling::*//input").first();
    if (await exportName.isVisible().catch(() => false)) {
      await exportName.fill("gmcc-week.csv").catch(() => {});
    }

    // Confirm what we set
    await saveArtifacts(page, "dates-confirm");

    // === RUN THE EXPORT ===
    console.log("→ Clicking Process…");
    const processBtn = root.getByRole("button", { name: /^Process$/i }).first();
    await processBtn.click();

    // Close “Success / Check notification center” dialog
    const ok = page.locator('.ui-dialog button:has-text("Close"), .ui-dialog button:has-text("OK")').first();
    if (await ok.isVisible({ timeout: 15_000 }).catch(() => false)) await ok.click().catch(() => {});

    // Open notification center and click “Preview Document”
    console.log("→ Opening Notification Center …");
    // The bell is the sidebar button with no text; grab the one that opens a panel
    const sidebarButtons = page.locator("aside button, nav button, .sidebar button");
    const count = await sidebarButtons.count();
    for (let i = 0; i < Math.min(count, 8); i++) {
      const b = sidebarButtons.nth(i);
      await b.click().catch(() => {});
      const preview = page.locator('button:has-text("Preview Document"), a:has-text("Preview Document")').first();
      if (await preview.isVisible({ timeout: 1500 }).catch(() => false)) {
        const dl = page.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
        await preview.click().catch(() => {});
        var download = await dl; // eslint-disable-line no-var
        if (download) break;
      }
    }
    if (!download) { // fallback: any CSV link
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

    // Optional S3 publish (so your Vercel site can read a stable URL)
    if (S3_BUCKET) {
      await uploadToS3("gmcc-week.csv", Buffer.from(filteredText, "utf8"));
      await uploadToS3("gmcc-week-raw.csv", Buffer.from(rawText, "utf8"));
    }
  } catch (err) {
    console.error("✖ Run failed:", err.message);
    await saveArtifacts(page, "error");
    process.exitCode = 1;
  } finally {
    await browser.close();
  }
})();