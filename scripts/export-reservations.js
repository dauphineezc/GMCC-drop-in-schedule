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
  // Handles the "Login Prompts" → "Continue" dialog if present.
  const prompt = pageOrFrame.locator('text=Login Prompts');
  if (await prompt.first().isVisible({ timeout: 500 }).catch(() => false)) {
    const btn = pageOrFrame.getByRole('button', { name: /continue/i });
    await btn.click({ timeout: 8000 }).catch(()=>{});
    await pageOrFrame.waitForLoadState('networkidle', { timeout: 15000 }).catch(()=>{});
    await pageOrFrame.waitForTimeout(600);
  }
}

async function waitOutSpinner(pageOrFrame) {
  // Wait for "Please Wait..." overlay (if shown) to disappear.
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

  // Login loop: up to 90s, do whichever step is needed right now.
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    // Handle resume prompts on page or any frame
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);

    // If we are no longer on the login route, break (logged in or session restored)
    if (!page.url().includes('#/login')) break;

    // If login form is visible, fill it and submit
    const userField = page.locator(userSel).first();
    const passField = page.locator(passSel).first();
    const hasLogin = await userField.isVisible({ timeout: 5000 }).catch(()=>false);

    if (hasLogin) {
      await userField.fill(USERNAME);
      await passField.fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(()=>{}),
        page.click(submitSel).catch(()=>{})
      ]);
      // after submit, loop will run again to handle spinner/prompt
      continue;
    }

    // Nothing actionable yet → small wait, then try again
    await page.waitForTimeout(800);
  }

  if (page.url().includes('#/login')) {
    await saveFailureArtifacts(page, 'login-stuck');
    throw new Error('Login did not complete.');
  }
}

async function findGridRoot(page) {
  const headerTextCandidates = [
    'Facility Reservation Interface',
    'Facility DataGrid',
    'Facilities'
  ];

  const tryRoot = async (root) => {
    await waitOutSpinner(root);
    await clickIfResumePrompt(root);

    for (const t of headerTextCandidates) {
      const ok = await root.locator(`text=${t}`).first().isVisible({ timeout: 1200 }).catch(()=>false);
      if (ok) return root;
    }
    // Fallback: presence of the Short Description filter input
    const filter = root.locator('input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]');
    if (await filter.first().isVisible({ timeout: 1200 }).catch(()=>false)) return root;
    return null;
  };

  let root = await tryRoot(page);
  if (root) return root;

  for (const f of page.frames()) {
    root = await tryRoot(f);
    if (root) return root;
  }
  return null;
}

// click the "Continue session" modal if it shows up (you already have this)
async function clickIfResumePrompt(pageOrFrame) { /* unchanged */ }

// wait out the "Please Wait..." overlay if it flashes
async function waitOutSpinner(pageOrFrame) {
  const spinner = pageOrFrame.locator('text=/Please\\s+Wait/i');
  if (await spinner.first().isVisible({ timeout: 500 }).catch(()=>false)) {
    await spinner.first().waitFor({ state: 'detached', timeout: 30000 }).catch(()=>{});
  }
}

// NEW: explicitly open the Facility DataGrid from the left toolbar
async function openFacilityDataGrid(page) {
  await waitOutSpinner(page);
  await clickIfResumePrompt(page);

  // If the grid header is already visible, nothing to do
  if (await page.getByText(/Facility DataGrid/i).first().isVisible({ timeout: 1000 }).catch(()=>false)) return;

  // Try a handful of ways the button is exposed (Vuetify tooltips, titles, aria labels, etc.)
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

// Beefier grid finder: poll up to ~30s across page & iframes
async function findGridRoot(page) {
  const headerTexts = [/Facility Reservation Interface/i, /Facility DataGrid/i, /Facilities/i];
  const filterSel = 'input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]';

  const tryRoot = async (root) => {
    await waitOutSpinner(root);
    await clickIfResumePrompt(root);
    // header text?
    for (const rx of headerTexts) {
      if (await root.getByText(rx).first().isVisible({ timeout: 800 }).catch(()=>false)) return root;
    }
    // or the filter input?
    if (await root.locator(filterSel).first().isVisible({ timeout: 800 }).catch(()=>false)) return root;
    return null;
  };

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let root = await tryRoot(page);
    if (root) return root;

    for (const f of page.frames()) {
      root = await tryRoot(f);
      if (root) return root;
    }
    await page.waitForTimeout(700);
  }
  return null;
}


/* ---------- main ---------- */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // 1) Ensure we’re logged in
    await fullyLogin(page);

    // 2) Go to the Facilities grid/app screen
    await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);
    await openFacilityDataGrid(page);

    // 3) Find the grid (page or iframe)
    const root = await findGridRoot(page);
    if (!root) {
      await saveFailureArtifacts(page, 'no-grid');
      throw new Error('Could not find the Facilities grid. (Panel loaded but DataGrid never appeared.)');
    }

    // 4) Short Description filter
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

    // 6) Filter for each term and collect
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
