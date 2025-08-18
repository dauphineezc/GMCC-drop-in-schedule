// scripts/export-reservations.js
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const TIMEOUT = 60000;
const FAC_TERMS = ['Community Lounge','Multi-use Pool','Full A+B'];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL;
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ---------------- utils ---------------- */
async function saveFailureArtifacts(page, label) {
  try {
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), 'utf8');
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), 'utf8');
  } catch (_) {}
}

async function clickIfResumePrompt(pageOrFrame) {
  // “Login Prompts” → Continue
  const prompt = pageOrFrame.locator('text=Login Prompts');
  if (await prompt.first().isVisible({ timeout: 800 }).catch(() => false)) {
    const btn = pageOrFrame.getByRole('button', { name: /continue/i });
    await btn.click({ timeout: 8000 }).catch(() => {});
    await pageOrFrame.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
    await pageOrFrame.waitForTimeout(600);
  }
}

async function waitOutSpinner(pageOrFrame) {
  // “Please Wait…” overlay
  const spinner = pageOrFrame.locator('text=/Please\\s+Wait/i');
  if (await spinner.first().isVisible({ timeout: 800 }).catch(() => false)) {
    await spinner.first().waitFor({ state: 'detached', timeout: 30000 }).catch(() => {});
  }
}

function parseCsv(text) {
  // lightweight CSV parser that handles quoted commas
  const rows = [];
  let i = 0, field = '', inQ = false, row = [];
  while (i < text.length) {
    const c = text[i++];
    if (inQ) {
      if (c === '"') {
        if (text[i] === '"') { field += '"'; i++; }  // escaped quote
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
      else if (c === '\r') { /* ignore */ }
      else field += c;
    }
  }
  // trailing
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsv(rows) {
  const headers = Object.keys(rows[0] || {});
  const esc = v => `"${String(v ?? '').replaceAll('"','""')}"`;
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

/* ---------------- login & navigation ---------------- */
async function fullyLogin(page) {
  const userSel = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
  const passSel = 'input[name="password"], #password, input[type="password"]';
  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In")';

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);

    // If we’ve moved off the login route, we’re done
    if (!page.url().includes('#/login')) return;

    // Try to submit the form if visible
    const userField = page.locator(userSel).first();
    const hasLogin = await userField.isVisible({ timeout: 1500 }).catch(() => false);
    if (hasLogin) {
      await userField.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.click(submitSel).catch(() => {})
      ]);
      continue;
    }

    await page.waitForTimeout(600);
  }

  await saveFailureArtifacts(page, 'login-stuck');
  throw new Error('Login did not complete.');
}

async function openFacilityPanel(context, page) {
  // Go to the launcher route
  await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });
  await clickIfResumePrompt(page);
  await waitOutSpinner(page);

  // Some installs open a legacy popup. Arm the listener *before* any clicks.
  const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);

  // If the page already shows content, great; otherwise try clicking a launcher if visible.
  // (We keep this guarded so it’s harmless if nothing is needed.)
  const maybeLaunchers = [
    page.getByRole('button', { name: /facility.*(data)?grid/i }),
    page.getByRole('link',   { name: /facility reservation interface/i }),
    page.locator('a:has-text("Facility DataGrid")'),
    page.locator('button:has-text("DataGrid")'),
  ];
  for (const l of maybeLaunchers) {
    if (await l.first().isVisible({ timeout: 800 }).catch(() => false)) {
      await l.first().click().catch(() => {});
      break;
    }
  }

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(() => {});
    await clickIfResumePrompt(popup);
    await waitOutSpinner(popup);
    return popup; // work in the popup
  }
  return page; // work in current tab
}

async function findGridRoot(workPage) {
  const headerRx = /Facility Reservation Interface/i;
  const gridTitleRx = /Facility DataGrid/i;

  const filterSel = 'input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]';

  async function tryRoot(root) {
    await clickIfResumePrompt(root);
    await waitOutSpinner(root);

    // Header + grid card check
    const hasHeader = await root.getByText(headerRx).first()
      .isVisible({ timeout: 800 }).catch(() => false);
    const hasGridTitle = await root.getByText(gridTitleRx).first()
      .isVisible({ timeout: 800 }).catch(() => false);

    if (hasHeader && hasGridTitle) return root;

    // Fallback: filter input (when filters are visible)
    if (await root.locator(filterSel).first().isVisible({ timeout: 800 }).catch(() => false)) return root;

    return null;
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    // Try page itself
    let r = await tryRoot(workPage);
    if (r) return r;

    // Try iframes
    for (const f of workPage.frames()) {
      r = await tryRoot(f);
      if (r) return r;
    }

    // If the tab caption exists but the panel body is blank, try nudging it
    const tab = workPage.getByRole('tab', { name: headerRx }).first();
    if (await tab.isVisible({ timeout: 300 }).catch(() => false)) {
      await tab.click().catch(() => {});
    }

    await workPage.waitForTimeout(700);
  }

  return null;
}

/* ---------------- export & filter ---------------- */
async function exportCsvFromGrid(root) {
  // Open the gear menu in the “Facility DataGrid” header and click “Export Comma Delimited”
  // We look for the grid card container first to scope our search.
  const card = root.locator('div:has(> .v-card-title:has-text("Facility DataGrid")), div:has-text("Facility DataGrid")')
                   .first();

  // Try a handful of gear-button selectors
  const gearCandidates = [
    card.getByRole('button', { name: /settings/i }),
    card.locator('button[aria-label*="Settings" i]'),
    card.locator('button:has(i[class*="mdi-cog"])'),
    card.locator('i[class*="mdi-cog"]').first().locator('xpath=ancestor::button[1]')
  ];

  let clicked = false;
  for (const c of gearCandidates) {
    if (await c.isVisible({ timeout: 800 }).catch(() => false)) {
      await c.click().catch(() => {});
      clicked = true;
      break;
    }
  }
  if (!clicked) {
    // Last-ditch: click the very first small icon button in the card header area
    const firstIcon = card.locator('button').first();
    await firstIcon.click({ timeout: 2000 }).catch(() => {});
  }

  // Now click the menu item
  const menuItem = root.getByRole('menuitem', { name: /export.*comma/i }).first();
  if (!await menuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    // Some builds render the popup as a listitem/button
    const alt = root.locator('div[role="menu"] >> text=/Export\\s+Comma\\s+Delimited/i').first();
    if (await alt.isVisible({ timeout: 1500 }).catch(() => false)) {
      await alt.click().catch(() => {});
    } else {
      await saveFailureArtifacts(root.page ? root.page() : root, 'no-export-menu');
      throw new Error('Could not open the “Export Comma Delimited” menu.');
    }
  } else {
    await menuItem.click().catch(() => {});
  }
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

  const wanted = new Set(FAC_TERMS.map(s => s.toLowerCase()));
  const out = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const short = (row[idxShort] || '').toLowerCase();
    // keep if the whole short desc equals one of our terms OR contains any term
    const keep = Array.from(wanted).some(t => short.includes(t));
    if (keep) {
      out.push({
        facClass:     row[idxClass] ?? '',
        facLocation:  row[idxLoc]   ?? '',
        facCode:      row[idxCode]  ?? '',
        facShortDesc: row[idxShort] ?? '',
        status:       row[idxStat]  ?? ''
      });
    }
  }
  return out;
}

/* ---------------- main ---------------- */
(async () => {
  const browser = await chromium.launch({ headless: true });
  // acceptDownloads is required to capture the CSV
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // 1) Login
    await fullyLogin(page);

    // 2) Open panel (and switch to popup if RecTrac spawns one)
    const workPage = await openFacilityPanel(context, page);

    // 3) Find the grid (page or iframe)
    let root = await findGridRoot(workPage);
    if (!root) {
      // Sometimes the panel paints blank once; a soft reload can kick it
      await workPage.reload({ waitUntil: 'domcontentloaded' }).catch(() => {});
      await waitOutSpinner(workPage);
      root = await findGridRoot(workPage);
    }
    if (!root) {
      await saveFailureArtifacts(workPage, 'no-grid');
      throw new Error('Could not find the Facilities grid (blank panel or legacy UI not detected).');
    }

    // 4) Export CSV via gear menu
    const downloadPromise = workPage.waitForEvent('download', { timeout: 20000 }).catch(() => null);
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
      // Write an empty but well-formed CSV so downstream steps still succeed
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
