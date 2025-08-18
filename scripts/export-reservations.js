// scripts/export-reservations.js
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

/* ---------- config ---------- */
const FAC_TERMS = ['Community Lounge', 'Multi-use Pool', 'Full A+B'];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;       // e.g. .../login.html?InterfaceParameter=...#/login
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL;
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

const NAV_TIMEOUT = 120000;   // generous for first page loads / SSO
const OP_TIMEOUT  = 90000;    // general operations

/* ---------- helpers ---------- */
const isLoginUrl = (url) => (url || '').includes('#/login');

async function saveFailureArtifacts(pageOrFrame, label) {
  try {
    const page = pageOrFrame.page ? pageOrFrame.page() : pageOrFrame;
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), 'utf8');
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), 'utf8');
  } catch {}
}

async function clickIfResumePrompt(pageOrFrame) {
  // Handles a possible “Login Prompts” → Continue dialog
  const prompt = pageOrFrame.locator('text=Login Prompts');
  if (await prompt.first().isVisible({ timeout: 800 }).catch(() => false)) {
    await pageOrFrame.getByRole('button', { name: /continue/i })
      .click({ timeout: 8000 }).catch(() => {});
    await pageOrFrame.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await pageOrFrame.waitForTimeout(600);
  }
}

async function waitOutSpinner(pageOrFrame) {
  // Wait out “Please Wait…” overlay if it appears
  const spinner = pageOrFrame.locator('text=/Please\\s+Wait/i');
  if (await spinner.first().isVisible({ timeout: 800 }).catch(() => false)) {
    await spinner.first().waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
  }
}

function parseCsv(text) {
  // minimal CSV parser (handles quotes and commas)
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

/* ---------- state: login ---------- */
async function gotoWithRetries(page, url, attempts = 3) {
  for (let i = 1; i <= attempts; i++) {
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: NAV_TIMEOUT });
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      return;
    } catch (e) {
      await saveFailureArtifacts(page, `goto-failed-${i}`);
      if (i === attempts) throw e;
      await page.waitForTimeout(1500);
    }
  }
}

async function fullyLogin(page) {
  const userSel   = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
  const passSel   = 'input[name="password"], #password, input[type="password"]';
  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In")';

  // Always start from the login URL and *stay* in a loop until we’re off #/login
  await gotoWithRetries(page, LOGIN_URL);

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);

    if (!isLoginUrl(page.url())) {
      // We’re no longer on the login route → logged in (or session restored)
      return;
    }

    const userField = page.locator(userSel).first();
    if (await userField.isVisible({ timeout: 2500 }).catch(() => false)) {
      await userField.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.click(submitSel).catch(() => {}),
      ]);
      // loop continues; we only exit once URL is *not* #/login
      continue;
    }

    await page.waitForTimeout(700);
  }

  await saveFailureArtifacts(page, 'login-stuck');
  throw new Error('Login did not complete.');
}

/* ---------- state: open facility panel (and detect popup) ---------- */
async function openFacilityPanel(context, page) {
  // Navigate to the panel launcher. If we get bounced to login, go log in first.
  await gotoWithRetries(page, GRID_URL);
  if (isLoginUrl(page.url())) {
    await fullyLogin(page);
    await gotoWithRetries(page, GRID_URL);
  }

  // Arm popup listener *before* clicking anything
  const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);

  await clickIfResumePrompt(page);
  await waitOutSpinner(page);

  // If we’re already showing the interface, fine; else try a launcher button/link.
  const maybeLaunchers = [
    page.getByRole('button', { name: /facility.*(data)?grid/i }),
    page.getByRole('link',   { name: /facility reservation interface/i }),
    page.locator('a:has-text("Facility DataGrid")'),
    page.locator('button:has-text("DataGrid")'),
  ];
  for (const l of maybeLaunchers) {
    const first = l.first();
    if (await first.isVisible({ timeout: 800 }).catch(() => false)) {
      await first.click().catch(() => {});
      break;
    }
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await clickIfResumePrompt(popup);
    await waitOutSpinner(popup);

    // If the popup *also* got redirected to login, fix that and return to GRID_URL again.
    if (isLoginUrl(popup.url())) {
      await fullyLogin(popup);
      await gotoWithRetries(popup, GRID_URL);
      await waitOutSpinner(popup);
    }
    return popup;
  }

  // No popup—work in the current tab. If we somehow got bounced to login, fix it.
  if (isLoginUrl(page.url())) {
    await fullyLogin(page);
    await gotoWithRetries(page, GRID_URL);
  }
  return page;
}

/* ---------- state: detect Facilities grid ---------- */
async function findGridRoot(workPage) {
  const headerRx     = /Facility Reservation Interface/i;
  const gridTitleRx  = /Facility DataGrid/i;
  const filterSel    = 'input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]';

  const tryRoot = async (root) => {
    await clickIfResumePrompt(root);
    await waitOutSpinner(root);

    const hasHeader    = await root.getByText(headerRx).first().isVisible({ timeout: 800 }).catch(() => false);
    const hasGridTitle = await root.getByText(gridTitleRx).first().isVisible({ timeout: 800 }).catch(() => false);
    if (hasHeader && hasGridTitle) return root;

    // sometimes filters are visible even before the heading gets painted
    if (await root.locator(filterSel).first().isVisible({ timeout: 800 }).catch(() => false)) return root;

    return null;
  };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // If we somehow got redirected to login at this point, repair and re-open the panel.
    if (isLoginUrl(workPage.url())) return null;

    let r = await tryRoot(workPage);
    if (r) return r;

    for (const f of workPage.frames()) {
      r = await tryRoot(f);
      if (r) return r;
    }

    // If the tab label exists but content is blank, nudge the tab
    const tab = workPage.getByRole('tab', { name: headerRx }).first();
    if (await tab.isVisible({ timeout: 300 }).catch(() => false)) {
      await tab.click().catch(() => {});
    }

    await workPage.waitForTimeout(700);
  }
  return null;
}

/* ---------- export via gear menu ---------- */
async function exportCsvFromGrid(root) {
  // Scope to the “Facility DataGrid” card
  const card = root.locator('div:has(> .v-card-title:has-text("Facility DataGrid")), div:has-text("Facility DataGrid")').first();

  // Open gear menu
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
      opened = true;
      break;
    }
  }
  if (!opened) {
    await card.locator('button').first().click({ timeout: 2000 }).catch(() => {});
  }

  // Click “Export Comma Delimited”
  const menuItem = root.getByRole('menuitem', { name: /export.*comma/i }).first();
  if (await menuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await menuItem.click().catch(() => {});
  } else {
    const alt = root.locator('div[role="menu"] >> text=/Export\\s+Comma\\s+Delimited/i').first();
    if (await alt.isVisible({ timeout: 1500 }).catch(() => false)) {
      await alt.click().catch(() => {});
    } else {
      await saveFailureArtifacts(root, 'no-export-menu');
      throw new Error('Could not open the “Export Comma Delimited” menu.');
    }
  }
}

/* ---------- post-process CSV locally ---------- */
function filterDownloadedCsv(csvText) {
  const rows = parseCsv(csvText);
  if (!rows.length) return [];

  const headers = rows[0];
  const idxShort = headers.findIndex(h => /fac.*short.*desc/i.test(h));
  const idxClass = headers.findIndex(h => /fac.*class/i.test(h));
  const idxLoc   = headers.findIndex(h => /fac.*loc/i.test(h));
  const idxCode  = headers.findIndex(h => /fac.*code/i.test(h));
  const idxStat  = headers.findIndex(h => /status/i.test(h));

  const wanted = FAC_TERMS.map(t => t.toLowerCase());
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

/* ---------- main ---------- */
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
    // 1) Ensure we’re authenticated
    await fullyLogin(page);

    // 2) Open the Facility Reservation Interface (switch to popup if RecTrac spawns one)
    let workPage = await openFacilityPanel(context, page);

    // If at any point we’re on #/login, repair and re-open
    if (isLoginUrl(workPage.url())) {
      await fullyLogin(workPage);
      workPage = await openFacilityPanel(context, workPage);
    }

    // 3) Find grid
    let root = await findGridRoot(workPage);
    if (!root) {
      // If we somehow bounced to login after navigation, repair once and retry
      if (isLoginUrl(workPage.url())) {
        await fullyLogin(workPage);
        workPage = await openFacilityPanel(context, workPage);
        root = await findGridRoot(workPage);
      }
    }
    if (!root) {
      await saveFailureArtifacts(workPage, 'no-grid');
      throw new Error('Could not find the Facilities grid (blank panel or legacy UI not detected).');
    }

    // 4) Export CSV via gear menu and capture the download
    const downloadPromise = workPage.waitForEvent('download', { timeout: 25000 }).catch(() => null);
    await exportCsvFromGrid(root);

    const download = await downloadPromise;
    if (!download) {
      await saveFailureArtifacts(workPage, 'no-download');
      throw new Error('Export did not trigger a CSV download.');
    }

    const tmpPath = await download.path();
    const csvText = fs.readFileSync(tmpPath, 'utf8');

    // 5) Filter locally to our target facilities and write final CSV
    const filtered = filterDownloadedCsv(csvText);
    const outPath = path.resolve('gmcc-week.csv');
    if (filtered.length) {
      fs.writeFileSync(outPath, toCsv(filtered), 'utf8');
      console.log(`Wrote ${filtered.length} rows to ${outPath}`);
    } else {
      fs.writeFileSync(outPath, toCsv([{ facClass:'', facLocation:'', facCode:'', facShortDesc:'', status:'' }]).trim() + '\n', 'utf8');
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
