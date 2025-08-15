import { chromium } from 'playwright';
import fs from 'fs';

const TIMEOUT = 60000;
const FAC_TERMS = ['Community Lounge', 'Multi-use Pool', 'Full A+B'];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL;
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ---------- small utils ---------- */
function toCsv(rows) {
  const headers = Object.keys(rows[0] || { facClass:'', facLocation:'', facCode:'', facShortDesc:'', status:'' });
  const esc = v => `"${String(v ?? '').replaceAll('"','""')}"`;
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

async function saveFailureArtifacts(page, label) {
  try {
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), 'utf8');
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), 'utf8');
  } catch {}
}

async function clickIfResumePrompt(pageOrFrame) {
  const prompt = pageOrFrame.locator('text=Login Prompts');
  if (await prompt.first().isVisible({ timeout: 700 }).catch(() => false)) {
    await pageOrFrame.getByRole('button', { name: /continue/i }).click({ timeout: 8000 }).catch(()=>{});
    await pageOrFrame.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    await pageOrFrame.waitForTimeout(600);
  }
}

async function waitOutSpinner(pageOrFrame) {
  const spinner = pageOrFrame.locator('text=/Please\\s+Wait/i');
  if (await spinner.first().isVisible({ timeout: 700 }).catch(()=>false)) {
    await spinner.first().waitFor({ state: 'detached', timeout: 30000 }).catch(()=>{});
  }
}

/* CSV parsing that handles quotes/commas/newlines */
function parseCsv(text) {
  const rows = [];
  let i = 0, field = '', curr = [], inQ = false;
  while (i < text.length) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i+1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { curr.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && text[i+1] === '\n') i++;
        curr.push(field); field = '';
        rows.push(curr); curr = [];
      } else field += c;
    }
    i++;
  }
  if (field.length || curr.length) { curr.push(field); rows.push(curr); }
  return rows;
}

function norm(s) { return String(s||'').trim().toLowerCase(); }

/* ---------- login & navigation ---------- */
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

    if (!page.url().includes('#/login')) break;

    const userField = page.locator(userSel).first();
    const hasLogin = await userField.isVisible({ timeout: 4000 }).catch(()=>false);
    if (hasLogin) {
      await userField.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(()=>{}),
        page.click(submitSel).catch(()=>{})
      ]);
      continue;
    }
    await page.waitForTimeout(700);
  }

  if (page.url().includes('#/login')) {
    await saveFailureArtifacts(page, 'login-stuck');
    throw new Error('Login did not complete.');
  }
}

/** Open the Facility Reservation Interface panel.
 *  RecTrac may:
 *   - Keep you in the same tab,
 *   - Embed legacy UI in an iframe, or
 *   - Open a new popup tab.
 *  This returns the "work page" you should use for subsequent actions.
 */
async function openFacilityPanel(context, page) {
  await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });
  await clickIfResumePrompt(page);

  // Listen for a popup BEFORE any SPA-side navigation kicks in
  const popupPromise = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);

  // Give the SPA a moment to spawn iframe/popup
  await page.waitForTimeout(1500);

  const popup = await popupPromise;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded').catch(()=>{});
    await clickIfResumePrompt(popup);
    return popup;
  }

  // No popup: maybe an iframe
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const looksLikeLegacy = f.url().includes('legacy') ||
        await f.getByText(/Facility (Reservation|DataGrid)/i).first().isVisible({ timeout: 400 }).catch(()=>false);
      if (looksLikeLegacy) return page; // actions will still target this page; findGridRoot will drop into the frame
    }
    await page.waitForTimeout(400);
  }
  return page;
}

/* Find the grid root (page or frame) so subsequent locators work consistently */
async function findGridRoot(page) {
  const headerTexts = [/Facility Reservation Interface/i, /Facility DataGrid/i, /Facilities/i];

  const tryRoot = async (root) => {
    await waitOutSpinner(root);
    await clickIfResumePrompt(root);
    for (const rx of headerTexts) {
      if (await root.getByText(rx).first().isVisible({ timeout: 700 }).catch(()=>false)) return root;
    }
    // grid table present?
    if (await root.locator('table').first().isVisible({ timeout: 700 }).catch(()=>false)) return root;
    return null;
  };

  // page first
  let r = await tryRoot(page);
  if (r) return { root: r, frame: null };

  // then frames
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    for (const f of page.frames()) {
      const rr = await tryRoot(f);
      if (rr) return { root: rr, frame: f };
    }
    await page.waitForTimeout(500);
  }
  return { root: null, frame: null };
}

/* Open gear menu → click "Export Comma Delimited" and capture the download */
async function exportGridCsv(workPage, rootObj) {
  const root = rootObj.frame ?? workPage; // locators can run against the frame if present
  // Ensure the grid header is on-screen
  const header = root.getByText(/Facility DataGrid/i).first();
  await header.scrollIntoViewIfNeeded().catch(()=>{});

  // Try to click the gear button in the toolbar (first button is typically the gear)
  let clickedMenu = false;
  const candidates = [
    // obvious cases
    root.locator('button[title*="Settings" i]'),
    root.locator('button[aria-label*="Settings" i]'),
    root.locator('button:has(i[class*="mdi-cog"])'),
    // fallback: first button in the toolbar row near "Facility DataGrid"
    header.locator('xpath=..').locator('button').first()
  ];

  for (const loc of candidates) {
    const el = loc.first();
    if (await el.isVisible({ timeout: 1200 }).catch(()=>false)) {
      await el.click().catch(()=>{});
      clickedMenu = true;
      break;
    }
  }

  if (!clickedMenu) {
    await saveFailureArtifacts(workPage, 'no-gear');
    throw new Error('Could not open the grid gear menu.');
  }

  // Click the "Export Comma Delimited" menu item
  const menuItem = root.getByRole('menuitem', { name: /Export Comma Delimited/i }).first();
  if (!await menuItem.isVisible({ timeout: 4000 }).catch(()=>false)) {
    // Sometimes the menu renders as a simple list
    await root.locator('text=Export Comma Delimited').first().click({ timeout: 4000 }).catch(()=>{});
  } else {
    await menuItem.click().catch(()=>{});
  }

  // Wait for the download
  const download = await workPage.waitForEvent('download', { timeout: 60000 }).catch(()=>null);
  if (!download) {
    await saveFailureArtifacts(workPage, 'no-download');
    throw new Error('Export did not trigger a download.');
  }

  const rawPath = 'rectrac-export.csv';
  await download.saveAs(rawPath);
  return rawPath;
}

/* ---------- main ---------- */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ acceptDownloads: true });
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // 1) Login
    await fullyLogin(page);

    // 2) Open the panel; capture popup if RecTrac spawns one
    const workPage = await openFacilityPanel(context, page);

    // 3) Find the grid (page or iframe)
    const { root, frame } = await findGridRoot(workPage);
    if (!root) {
      await saveFailureArtifacts(workPage, 'no-grid');
      throw new Error('Could not find the Facilities grid (blank panel or legacy UI not detected).');
    }

    // 4) Export full grid as CSV via gear menu
    const rawCsvPath = await exportGridCsv(workPage, { frame });

    // 5) Read & filter locally by Fac Short Description
    const raw = fs.readFileSync(rawCsvPath, 'utf8');
    const rows = parseCsv(raw);
    if (!rows.length) throw new Error('Downloaded CSV is empty.');

    const headers = rows[0];
    const body = rows.slice(1);

    // Build index map with tolerant header matching
    const idx = {};
    headers.forEach((h, i) => {
      const n = norm(h);
      if (n.includes('fac class')) idx.facClass = i;
      if (n.includes('fac location')) idx.facLocation = i;
      if (n.includes('fac code')) idx.facCode = i;
      if (n.includes('fac short')) idx.facShortDesc = i;
      if (n === 'status' || n.includes('status')) idx.status = i;
    });

    if (idx.facShortDesc == null) {
      await saveFailureArtifacts(workPage, 'no-filter'); // keep old label, useful for triage
      throw new Error('Could not find the "Fac Short Description" column in the CSV.');
    }

    const want = FAC_TERMS.map(t => norm(t));
    const picked = [];
    const dedup = new Map();

    for (const r of body) {
      const shortDesc = norm(r[idx.facShortDesc]);
      if (!shortDesc) continue;
      if (want.some(w => shortDesc.includes(w))) {
        const row = {
          facClass:     idx.facClass != null     ? r[idx.facClass]     : '',
          facLocation:  idx.facLocation != null  ? r[idx.facLocation]  : '',
          facCode:      idx.facCode != null      ? r[idx.facCode]      : '',
          facShortDesc: r[idx.facShortDesc],
          status:       idx.status != null       ? r[idx.status]       : ''
        };
        const key = row.facCode || row.facShortDesc;
        if (!dedup.has(key)) { dedup.set(key, true); picked.push(row); }
      }
    }

    const outPath = 'gmcc-week.csv';
    fs.writeFileSync(outPath, toCsv(picked), 'utf8');
    console.log(`Wrote ${picked.length} filtered rows to ${outPath}`);

  } catch (err) {
    console.error('Scrape failed:', err);
    await saveFailureArtifacts(page, 'error');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
