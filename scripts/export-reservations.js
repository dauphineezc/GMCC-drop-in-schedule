// scripts/export-reservations.js
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const TIMEOUT = 60000;
const FAC_TERMS = ['Community Lounge', 'Multi-use Pool', 'Full A+B'];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;
const PANEL_URL = process.env.RECTRAC_FACILITY_GRID_URL; // the panel route you already use
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

function log(msg){ console.log(`[export] ${msg}`); }

/* ---------------- CSV helpers ---------------- */
function parseCsv(text) {
  // tolerant CSV parser good enough for RecTrac’s export
  const rows = [];
  let i = 0, field = '', row = [], inQuotes = false;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i++; continue;
      }
      field += c; i++; continue;
    }
    if (c === '"') { inQuotes = true; i++; continue; }
    if (c === ',') { row.push(field); field = ''; i++; continue; }
    if (c === '\r') { i++; continue; }
    if (c === '\n') { row.push(field); rows.push(row); field=''; row=[]; i++; continue; }
    field += c; i++;
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsvRows(rows) {
  const esc = (v) => `"${String(v ?? '').replaceAll('"','""')}"`;
  return rows.map(r => r.map(esc).join(',')).join('\n');
}

function filterReservationsCsv(csvText, keepTerms) {
  const rows = parseCsv(csvText);
  if (!rows.length) return csvText;

  const header = rows[0].map(h => h.trim());
  // Try to find the most likely facility columns
  const nameIdx = header.findIndex(h => /fac(?:ility)?\s*short\s*desc/i.test(h) || /facility(?!.*code)/i.test(h));
  const locationIdx = header.findIndex(h => /fac\s*location/i.test(h));

  const termMatch = (v) => {
    const val = String(v || '').toLowerCase();
    return keepTerms.some(t => val.includes(t.toLowerCase()));
  };

  const filtered = [header];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const hit =
      (nameIdx >= 0 && termMatch(r[nameIdx])) ||
      (locationIdx >= 0 && termMatch(r[locationIdx]));
    if (hit) filtered.push(r);
  }
  return toCsvRows(filtered);
}

/* ---------------- debug artifacts ---------------- */
async function saveArtifacts(page, label){
  try{
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), 'utf8');
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), 'utf8');
  } catch {}
}

/* ---------------- small UI helpers ---------------- */
async function clickIfResumePrompt(pageLike){
  const box = pageLike.locator('text=Login Prompts');
  if (await box.first().isVisible({ timeout: 800 }).catch(()=>false)) {
    await pageLike.getByRole('button', { name: /continue/i }).click().catch(()=>{});
    await pageLike.waitForLoadState('networkidle').catch(()=>{});
    await pageLike.waitForTimeout(500);
  }
}
async function waitOutSpinner(pageLike){
  const sp = pageLike.locator('text=/Please\\s+Wait/i');
  if (await sp.first().isVisible({ timeout: 800 }).catch(()=>false)) {
    await sp.first().waitFor({ state: 'detached', timeout: 30000 }).catch(()=>{});
  }
}

/* ---------------- login ---------------- */
async function fullyLogin(page){
  const userSel = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
  const passSel = 'input[name="password"], #password, input[type="password"]';
  const submit  = 'button[type="submit"], input[type="submit"], button:has-text("Sign In")';

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);

    if (!page.url().includes('#/login')) break;

    const user = page.locator(userSel).first();
    if (await user.isVisible({ timeout: 1500 }).catch(()=>false)) {
      await user.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(()=>{}),
        page.click(submit).catch(()=>{})
      ]);
      continue;
    }
    await page.waitForTimeout(600);
  }
  if (page.url().includes('#/login')) {
    await saveArtifacts(page, 'login-stuck');
    throw new Error('Login did not complete.');
  }
}

/* ---------------- open panel & download ---------------- */
async function openFacilityPanel(context, page) {
  await page.goto(PANEL_URL, { waitUntil: 'domcontentloaded' });
  await clickIfResumePrompt(page);
  for (const f of page.frames()) await clickIfResumePrompt(f);
  await waitOutSpinner(page);

  // In most tenants the panel is already focused when you hit the /panel/... route.
  // If your build requires a click, add it here. Otherwise just return the page.
  return page;
}

async function processAndDownloadCSV(workPage) {
  // Many RecTrac sites download directly on "Process". Some show a report window first.
  // We cover both paths.

  const outTmp = path.resolve('raw-export.csv');

  // Prefer waiting for download BEFORE clicking Process
  const dlPromise = workPage.waitForEvent('download', { timeout: 60000 }).catch(()=>null);
  const popupPromise = workPage.context().waitForEvent('page', { timeout: 10000 }).catch(()=>null);

  // Click the Process button (bottom left of the panel)
  const clickProcess = async () => {
    const candidates = [
      workPage.getByRole('button', { name: /^Process$/i }),
      workPage.locator('button:has-text("Process")')
    ];
    for (const c of candidates) {
      const el = c.first();
      if (await el.isVisible({ timeout: 1500 }).catch(()=>false)) {
        await el.click().catch(()=>{});
        return true;
      }
    }
    return false;
  };

  if (!await clickProcess()) {
    await saveArtifacts(workPage, 'no-process');
    throw new Error('Could not find the "Process" button.');
  }

  // Path 1: direct download
  const dl = await dlPromise;
  if (dl) {
    await dl.saveAs(outTmp);
    return outTmp;
  }

  // Path 2: popup with an Export button
  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded');
    await clickIfResumePrompt(popup);
    await waitOutSpinner(popup);

    const tryExport = async (root) => {
      const btns = [
        root.getByRole('button', { name: /export|download|csv|excel/i }),
        root.locator('[title*="Export" i]'),
        root.locator('[aria-label*="Export" i]'),
        root.locator('button:has-text("CSV"), a:has-text("CSV")'),
        root.locator('button:has-text("Excel"), a:has-text("Excel")'),
      ];
      for (const b of btns) {
        const el = b.first();
        if (await el.isVisible({ timeout: 1500 }).catch(()=>false)) {
          const dl2 = popup.waitForEvent('download', { timeout: 30000 }).catch(()=>null);
          await el.click().catch(()=>{});
          const got = await dl2;
          if (got) {
            await got.saveAs(outTmp);
            return true;
          }
        }
      }
      return false;
    };

    if (await tryExport(popup)) return outTmp;
    for (const f of popup.frames()) { if (await tryExport(f)) return outTmp; }

    await saveArtifacts(popup, 'no-export');
    throw new Error('Results opened, but no Export/CSV download was found.');
  }

  await saveArtifacts(workPage, 'no-download');
  throw new Error('Process did not trigger a download or a results window.');
}

/* ---------------- main ---------------- */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    log('login…');
    await fullyLogin(page);

    log('open panel…');
    const workPage = await openFacilityPanel(context, page);

    log('process & download full CSV…');
    const rawPath = await processAndDownloadCSV(workPage);

    log('filtering to target facilities…');
    const rawText = fs.readFileSync(rawPath, 'utf8');
    const filteredText = filterReservationsCsv(rawText, FAC_TERMS);

    const outPath = 'gmcc-week.csv';
    fs.writeFileSync(outPath, filteredText, 'utf8');
    log(`Wrote ${outPath}`);

  } catch (err) {
    console.error('Scrape failed:', err);
    await saveArtifacts(page, 'error');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
