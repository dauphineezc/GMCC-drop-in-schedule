// scripts/export-reservations.js
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

/* ===================== Config ===================== */
const FAC_TERMS = ['Community Lounge', 'Multi-use Pool', 'Full A+B'];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;                 // e.g. .../login.html?...#/login
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL;         // e.g. ...#/panel/<UUID>/legacy
const HOME_URL  =
  process.env.RECTRAC_HOME_URL ||
  (LOGIN_URL ? `${LOGIN_URL.split('#')[0]}#/home` : undefined);  // fallback if not provided

const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

// generous timeouts — WAN login/panels can be slow
const NAV_TIMEOUT = 120000;   // first-load navigation
const OP_TIMEOUT  = 90000;    // general ops

/* ===================== Utils ===================== */
async function saveFailureArtifacts(page, label) {
  try {
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), 'utf8');
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), 'utf8');
  } catch { /* ignore */ }
}

async function clickIfResumePrompt(pageOrFrame) {
  // RecTrac sometimes shows a small "Login Prompts" → Continue dialog
  const prompt = pageOrFrame.locator('text=Login Prompts');
  if (await prompt.first().isVisible({ timeout: 800 }).catch(() => false)) {
    const btn = pageOrFrame.getByRole('button', { name: /continue/i });
    await btn.click({ timeout: 8000 }).catch(() => {});
    await pageOrFrame.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await pageOrFrame.waitForTimeout(600);
  }
}

async function waitOutSpinner(pageOrFrame) {
  // “Please Wait …” overlay
  const spinner = pageOrFrame.locator('text=/Please\\s+Wait/i');
  if (await spinner.first().isVisible({ timeout: 800 }).catch(() => false)) {
    await spinner.first().waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
  }
}

function parseCsv(text) {
  // minimal CSV parser with quoted value support
  const rows = [];
  let i = 0, field = '', inQ = false, row = [];
  while (i < text.length) {
    const c = text[i++];
    if (inQ) {
      if (c === '"') {
        if (text[i] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c !== '\r') field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsv(rows) {
  const headers = Object.keys(rows[0] || { facClass:'', facLocation:'', facCode:'', facShortDesc:'', status:'' });
  const esc = v => `"${String(v ?? '').replaceAll('"','""')}"`;
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

/* ===================== Route helpers ===================== */
function onLoginRoute(p) {
  const u = p.url();
  return /#\/login/i.test(u) || /\/login\.html/i.test(u) && !/#\/(home|panel)/i.test(u);
}
function onHomeRoute(p) {
  return /#\/home/i.test(p.url());
}
function onPanelRoute(p) {
  return /#\/panel\/.+\/legacy/i.test(p.url());
}

/* ===================== Login ===================== */
async function fullyLogin(page) {
  const userSel   = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
  const passSel   = 'input[name="password"], #password, input[type="password"]';
  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In")';

  // Navigate to LOGIN_URL and wait for DOM to start
  let navAttempt = 0;
  while (navAttempt++ < 3) {
    try {
      await page.goto(LOGIN_URL, { waitUntil: 'commit', timeout: NAV_TIMEOUT });
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      break;
    } catch (e) {
      await saveFailureArtifacts(page, `goto-login-${navAttempt}`);
      if (navAttempt >= 3) throw e;
      await page.waitForTimeout(1500);
    }
  }

  // If we’re already beyond login, stop
  if (!onLoginRoute(page)) return;

  // Try up to 90s to submit
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);

    if (!onLoginRoute(page)) return; // routed away from login

    const user = page.locator(userSel).first();
    if (await user.isVisible({ timeout: 1500 }).catch(() => false)) {
      await user.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.locator(submitSel).first().click().catch(() => {}),
      ]);
      await page.waitForTimeout(700);
      continue;
    }

    await page.waitForTimeout(500);
  }

  await saveFailureArtifacts(page, 'login-stuck');
  throw new Error('Login did not complete.');
}

/* ===================== Open Facility Panel ===================== */
async function openFacilityPanel(context, page) {
  // 1) Try direct legacy panel URL first (fast path)
  if (GRID_URL) {
    await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });
    await clickIfResumePrompt(page);
    await waitOutSpinner(page);

    // legacy may open in a pop-up
    const popup = await context.waitForEvent('page', { timeout: 3000 }).catch(() => null);
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await clickIfResumePrompt(popup);
      await waitOutSpinner(popup);
      return popup;
    }

    // If we can already see the panel route, use it; blank panels get a fallback below
    if (onPanelRoute(page)) return page;
  }

  // 2) Fallback: go to Home and click the "Facility Reservation Interface" favorite tile
  if (!HOME_URL) throw new Error('HOME_URL could not be derived; set RECTRAC_HOME_URL or RECTRAC_LOGIN_URL.');

  // Ensure we’re actually logged in before attempting Home
  if (onLoginRoute(page)) {
    await fullyLogin(page);
  }
  await page.goto(HOME_URL, { waitUntil: 'domcontentloaded' });
  await clickIfResumePrompt(page);
  await waitOutSpinner(page);

  // The favorite tile (middle of three, but select by text to be robust)
  const tile = page
    .getByRole('button', { name: /facility\s+reservation\s+interface/i })
    .or(page.locator('div:has-text("Facility Reservation Interface")').first());

  if (await tile.first().isVisible({ timeout: 6000 }).catch(() => false)) {
    // Arm popup listener *before* click
    const popupPromise = context.waitForEvent('page', { timeout: 10000 }).catch(() => null);
    await tile.first().click().catch(() => {});
    const popup = await popupPromise;
    if (popup) {
      await popup.waitForLoadState('domcontentloaded').catch(() => {});
      await clickIfResumePrompt(popup);
      await waitOutSpinner(popup);
      return popup;
    }
    await waitOutSpinner(page);
    // If it stayed in same tab, it should now be on #/panel/.../legacy
    return page;
  }

  await saveFailureArtifacts(page, 'home-no-favorite');
  throw new Error('Could not find the "Facility Reservation Interface" favorite on Home.');
}

/* ===================== Find the grid ===================== */
async function findGridRoot(workPage) {
  const headerRx = /Facility Reservation Interface/i;
  const gridTitleRx = /Facility DataGrid/i;
  const filterSel = 'input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]';

  async function tryRoot(root) {
    await clickIfResumePrompt(root);
    await waitOutSpinner(root);

    const hasHeader = await root.getByText(headerRx).first().isVisible({ timeout: 600 }).catch(() => false);
    const hasGridTitle = await root.getByText(gridTitleRx).first().isVisible({ timeout: 600 }).catch(() => false);
    if (hasHeader && hasGridTitle) return root;

    if (await root.locator(filterSel).first().isVisible({ timeout: 600 }).catch(() => false)) return root;
    return null;
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // current page
    let r = await tryRoot(workPage);
    if (r) return r;

    // any iframes
    for (const f of workPage.frames()) {
      r = await tryRoot(f);
      if (r) return r;
    }

    // If the tab exists but body is blank, try nudging tab
    const tab = workPage.getByRole('tab', { name: headerRx }).first();
    if (await tab.isVisible({ timeout: 300 }).catch(() => false)) {
      await tab.click().catch(() => {});
    }

    await workPage.waitForTimeout(700);
  }
  return null;
}

/* ===================== Export via gear menu ===================== */
async function exportCsvFromGrid(root) {
  // grid card container
  const card = root
    .locator('div:has(> .v-card-title:has-text("Facility DataGrid")), div:has-text("Facility DataGrid")')
    .first();

  // open gear menu
  const gearCandidates = [
    card.getByRole('button', { name: /settings/i }),
    card.locator('button[aria-label*="Settings" i]'),
    card.locator('button:has(i[class*="mdi-cog"])'),
    card.locator('i[class*="mdi-cog"]').first().locator('xpath=ancestor::button[1]'),
  ];
  let opened = false;
  for (const g of gearCandidates) {
    if (await g.isVisible({ timeout: 800 }).catch(() => false)) {
      await g.click().catch(() => {});
      opened = true; break;
    }
  }
  if (!opened) {
    // last resort: click the first small icon in the header area
    await card.locator('button').first().click({ timeout: 2000 }).catch(() => {});
  }

  // click "Export Comma Delimited"
  const menuItem = root.getByRole('menuitem', { name: /export.*comma/i }).first();
  if (await menuItem.isVisible({ timeout: 2500 }).catch(() => false)) {
    await menuItem.click().catch(() => {});
    return;
  }
  const alt = root.locator('div[role="menu"] >> text=/Export\\s+Comma\\s+Delimited/i').first();
  if (await alt.isVisible({ timeout: 1500 }).catch(() => false)) {
    await alt.click().catch(() => {});
    return;
  }

  await saveFailureArtifacts(root.page ? root.page() : root, 'no-export-menu');
  throw new Error('Could not open the “Export Comma Delimited” menu.');
}

/* ===================== Post-filter the CSV ===================== */
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
    const short = (row[idxShort] || '').toLowerCase();
    if (wanted.some(t => short.includes(t))) {
      out.push({
        facClass:     row[idxClass] ?? '',
        facLocation:  row[idxLoc]   ?? '',
        facCode:      row[idxCode]  ?? '',
        facShortDesc: row[idxShort] ?? '',
        status:       row[idxStat]  ?? '',
      });
    }
  }
  return out;
}

/* ===================== Main ===================== */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: 'en-US',
    timezoneId: 'America/Detroit',
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  });
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  context.setDefaultTimeout(OP_TIMEOUT);

  const page = await context.newPage();

  try {
    /* 1) Make sure we’re logged in (only if on login route) */
    await fullyLogin(page);

    /* 2) Open Facility Reservation Interface panel (popup or same tab) */
    const workPage = await openFacilityPanel(context, page);

    // Route gate: do not proceed unless we see a panel route or the UI proves itself
    if (onLoginRoute(workPage)) {
      await saveFailureArtifacts(workPage, 'still-on-login');
      throw new Error('Still on login after attempting to open Facility Reservation Interface.');
    }

    /* 3) Find the grid (page or any iframe) */
    let root = await findGridRoot(workPage);
    if (!root) {
      // Sometimes the panel body renders blank once — nudge with a soft reload
      await workPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitOutSpinner(workPage);
      root = await findGridRoot(workPage);
    }
    if (!root) {
      await saveFailureArtifacts(workPage, 'no-grid');
      throw new Error('Could not find the Facilities grid (blank panel or legacy UI not detected).');
    }

    /* 4) Export CSV via gear menu */
    const dlPromise = workPage.waitForEvent('download', { timeout: 20000 }).catch(() => null);
    await exportCsvFromGrid(root);

    const download = await dlPromise;
    if (!download) {
      await saveFailureArtifacts(workPage, 'no-download');
      throw new Error('Export did not trigger a CSV download.');
    }

    const tmpPath = await download.path();
    const csvText = fs.readFileSync(tmpPath, 'utf8');

    /* 5) Filter locally & write final CSV */
    const filtered = filterDownloadedCsv(csvText);
    const outPath = path.resolve('gmcc-week.csv');
    if (filtered.length) {
      fs.writeFileSync(outPath, toCsv(filtered), 'utf8');
      console.log(`Wrote ${filtered.length} rows to ${outPath}`);
    } else {
      fs.writeFileSync(
        outPath,
        toCsv([{ facClass:'', facLocation:'', facCode:'', facShortDesc:'', status:'' }]).trim() + '\n',
        'utf8'
      );
      console.log(`Wrote 0 rows to ${outPath} (no matches after export).`);
    }
  } catch (err) {
    console.error('Scrape failed:', err);
    await saveFailureArtifacts(page, 'error');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
