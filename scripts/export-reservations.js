import { chromium } from 'playwright';
import fs from 'fs';

const TIMEOUT = 60000;
const FAC_TERMS = ['Community Lounge','Multi-use Pool','Full A+B'];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL;
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ---------- utils ---------- */
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
  // "Login Prompts" → Continue
  const prompt = pageOrFrame.locator('text=Login Prompts');
  if (await prompt.first().isVisible({ timeout: 500 }).catch(() => false)) {
    const btn = pageOrFrame.getByRole('button', { name: /continue/i });
    await btn.click({ timeout: 8000 }).catch(()=>{});
    await pageOrFrame.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    await pageOrFrame.waitForTimeout(600);
  }
}

async function waitOutSpinner(pageOrFrame) {
  // "Please Wait..." overlay
  const spinner = pageOrFrame.locator('text=/Please\\s+Wait/i');
  if (await spinner.first().isVisible({ timeout: 500 }).catch(()=>false)) {
    await spinner.first().waitFor({ state: 'detached', timeout: 30000 }).catch(()=>{});
  }
}

async function fullyLogin(page) {
  const userSel = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
  const passSel = 'input[name="password"], #password, input[type="password"]';
  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In")';

  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // Up to 90s: handle whichever step is present
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);

    if (!page.url().includes('#/login')) break; // past login

    const userField = page.locator(userSel).first();
    const hasLogin = await userField.isVisible({ timeout: 5000 }).catch(()=>false);

    if (hasLogin) {
      await userField.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(()=>{}),
        page.click(submitSel).catch(()=>{})
      ]);
      continue; // loop again to handle spinner/prompt
    }

    await page.waitForTimeout(800);
  }

  if (page.url().includes('#/login')) {
    await saveFailureArtifacts(page, 'login-stuck');
    throw new Error('Login did not complete.');
  }
}

async function openFacilityDataGrid(page) {
  await waitOutSpinner(page);
  await clickIfResumePrompt(page);

  // Already on the grid?
  if (await page.getByText(/Facility DataGrid/i).first().isVisible({ timeout: 1000 }).catch(()=>false)) return;

  // Try common button/tooltip/title variants for the left toolbar
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
    if (await el.isVisible({ timeout: 800 }).catch(()=>false)) {
      await el.click().catch(()=>{});
      await waitOutSpinner(page);
      break;
    }
  }
}

// Poll for the grid in page or any iframe
async function findGridRoot(page) {
  const headerTexts = [/Facility Reservation Interface/i, /Facility DataGrid/i, /Facilities/i];
  const filterSel = 'input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]';

  const tryRoot = async (root) => {
    await waitOutSpinner(root);
    await clickIfResumePrompt(root);
    for (const rx of headerTexts) {
      if (await root.getByText(rx).first().isVisible({ timeout: 800 }).catch(()=>false)) return root;
    }
    if (await root.locator(filterSel).first().isVisible({ timeout: 800 }).catch(()=>false)) return root;
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

async function openFacilityPanel(context, page) {
  // Go to the panel launcher route
  await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });

  // If a “Resume Session” prompt appears, clear it (reuse your helper)
  await clickIfResumePrompt(page);
  for (const f of page.frames()) await clickIfResumePrompt(f);

  // Start waiting for a popup **before** we click anything
  const waitPopup = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);

  // Try a few likely launchers; if your left-toolbar click is reliable, keep just that one
  const candidates = [
    page.getByRole('button', { name: /data\s*grid/i }),
    page.getByRole('link',   { name: /facility reservation interface/i }),
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

  // If RecTrac opened a legacy window, switch to it
  const popup = await waitPopup;
  if (popup) {
    await popup.waitForLoadState('domcontentloaded');
    await clickIfResumePrompt(popup);
    return popup;           // ← use this page from now on
  }

  // No popup? We’ll keep working in the current page (or an iframe within it)
  return page;
}


/* ---------- main ---------- */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // 1) Login
    await fullyLogin(page);

    // 2) open the panel and capture popup if one appears
    const workPage = await openFacilityPanel(context, page);
    
    // If RecTrac embeds the legacy UI in an iframe instead of a popup,
    // your existing findGridRoot(...) should be called with workPage
    const root = await findGridRoot(workPage);
    if (!root) {
      await saveFailureArtifacts(workPage, 'no-grid');
      throw new Error('Could not find the Facilities grid. (Panel loaded but DataGrid never appeared.)');
    }

    // 4) Filter input
    const SHORT_DESC_FILTER =
      'input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]';
    const filter = root.locator(SHORT_DESC_FILTER).first();
    if (!await filter.isVisible({ timeout: 15000 }).catch(()=>false)) {
      await saveFailureArtifacts(page, 'no-filter');
      throw new Error('Could not find the "Fac Short Description" filter input.');
    }

    // 5) Read rows helper
    async function readRows() {
      return root.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table tbody tr'));
        return rows.map(r => {
          const tds = r.querySelectorAll('td');
          return {
            facClass:     tds[0]?.innerText.trim() || '',
            facLocation:  tds[1]?.innerText.trim() || '',
            facCode:      tds[2]?.innerText.trim() || '',
            facShortDesc: tds[3]?.innerText.trim() || '',
            status:       tds[4]?.innerText.trim() || ''
          };
        }).filter(r => r.facShortDesc);
      });
    }

    // 6) Search each term; collect & dedupe
    const dedup = new Map();
    for (const term of FAC_TERMS) {
      await filter.fill('');
      await filter.type(term);
      await root.waitForTimeout(1000);
      const rows = await readRows();
      for (const row of rows) {
        const key = row.facCode || row.facShortDesc;
        dedup.set(key, row);
      }
    }

    // 7) Write CSV
    const result = Array.from(dedup.values());
    const outPath = 'gmcc-week.csv';
    fs.writeFileSync(outPath, toCsv(result), 'utf8');
    console.log(`Wrote ${result.length} rows to ${outPath}`);

  } catch (err) {
    console.error('Scrape failed:', err);
    await saveFailureArtifacts(page, 'error');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
