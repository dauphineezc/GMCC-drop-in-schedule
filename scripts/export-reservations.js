// scripts/export-reservations.js
import { chromium } from 'playwright';
import fs from 'fs';

const TIMEOUT = 60000;
const FAC_TERMS = ['Community Lounge','Multi-use Pool','Full A+B'];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL;
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ------------------------ utilities ------------------------ */
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

/* ------------------------ login flow ------------------------ */
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

/* ------------------------ legacy panel / popup ------------------------ */
async function openFacilityPanel(context, page) {
  // Go to the panel launcher route
  await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });

  await clickIfResumePrompt(page);
  for (const f of page.frames()) await clickIfResumePrompt(f);

  // Start waiting for a popup **before** we click anything
  const waitPopup = context.waitForEvent('page', { timeout: 15000 }).catch(() => null);

  // Try a few likely launchers; adjust as needed for your tenant
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

  // No popup? Keep working in the current page (or an iframe within it)
  return page;
}

async function openFacilityDataGrid(page) {
  // Sometimes the left toolbar has a specific DataGrid tool that must be clicked.
  await waitOutSpinner(page);
  await clickIfResumePrompt(page);

  if (await page.getByText(/Facility DataGrid/i).first().isVisible({ timeout: 1000 }).catch(()=>false)) return;

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

/* ------------------------ grid discovery ------------------------ */
async function findGridRoot(page) {
  const headerTexts = [/Facility Reservation Interface/i, /Facility DataGrid/i, /Facilities/i];

  const tryRoot = async (root) => {
    await waitOutSpinner(root);
    await clickIfResumePrompt(root);
    for (const rx of headerTexts) {
      if (await root.getByText(rx).first().isVisible({ timeout: 800 }).catch(()=>false)) return root;
    }
    // Sometimes the grid is present even if those headers aren't visible; look for a table.
    if (await root.locator('table').first().isVisible({ timeout: 800 }).catch(()=>false)) return root;
    return null;
  };

  // Poll page + any iframes up to 30s
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

/* ------------------------ grid helpers (filtering) ------------------------ */
async function getGridCard(root) {
  // the card/panel that contains "Facility DataGrid"
  const card = root.locator('div:has(> div:has-text("Facility DataGrid"))').first();
  await card.waitFor({ state: 'visible', timeout: 15000 });
  return card;
}

async function ensureFilterRowVisible(card) {
  // If there are no inputs in the 2nd header row, open the gear → Show Filters
  const filterRow = card.locator('thead tr').nth(1);
  const hasInputs = await filterRow.locator('input, textarea, [contenteditable="true"]').count();
  if (hasInputs === 0) {
    const gear = card.locator('button:has([class*="mdi-cog"]), button:has(svg)').first();
    if (await gear.isVisible().catch(()=>false)) {
      await gear.click().catch(()=>{});
      const menuItem = card.getByText(/show filters/i).first();
      if (await menuItem.isVisible().catch(()=>false)) await menuItem.click().catch(()=>{});
    }
  }
}

async function filterInputFor(card, headerLabelRegex) {
  // find which TH in the *first* header row contains our label,
  // then return the input/contenteditable in the same column of the filter row (row index 1)
  const ths = card.locator('thead tr').first().locator('th');
  const thCount = await ths.count();
  let idx = -1;
  for (let i = 0; i < thCount; i++) {
    const text = (await ths.nth(i).innerText()).trim();
    if (headerLabelRegex.test(text)) { idx = i; break; }
  }
  if (idx === -1) return null;

  const filterCell = card.locator('thead tr').nth(1).locator('th').nth(idx);
  let input = filterCell.locator('input, textarea, [contenteditable="true"]').first();
  if (!(await input.isVisible({ timeout: 1000 }).catch(()=>false))) {
    input = filterCell.locator('.v-field__input input, input').first();
  }
  return input;
}

async function readRowsFrom(card) {
  // Read visible rows from the grid table
  return card.evaluate((el) => {
    const table = el.querySelector('table') || document.querySelector('table');
    if (!table) return [];
    const rows = Array.from(table.querySelectorAll('tbody tr'));
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

/* ------------------------ main ------------------------ */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  // optional: capture all open page URLs for debugging at end of run
  process.on('beforeExit', async () => {
    try {
      const urls = context.pages().map(p => p.url()).join('\n');
      fs.writeFileSync('all-pages.txt', urls);
    } catch {}
  });

  try {
    // 1) Login
    await fullyLogin(page);

    // 2) Open the Facility panel (captures popup if RecTrac opens a legacy window)
    const workPage = await openFacilityPanel(context, page);

    // 3) If there is a left-toolbar DataGrid tool, click it
    await openFacilityDataGrid(workPage);

    // 4) Find the grid root (page or iframe)
    const root = await findGridRoot(workPage);
    if (!root) {
      await saveFailureArtifacts(workPage, 'no-grid');
      throw new Error('Could not find the Facilities grid. (Panel loaded but DataGrid never appeared.)');
    }

    // 5) Lock onto the grid card and ensure the filter row is visible
    const card = await getGridCard(root);
    await ensureFilterRowVisible(card);

    // 6) Get the "Fac Short Description" filter input by header text
    const shortDescInput = await filterInputFor(card, /Fac\s+Short\s+Description/i);
    if (!shortDescInput || !(await shortDescInput.isVisible().catch(()=>false))) {
      await saveFailureArtifacts(workPage, 'no-filter');
      throw new Error('Could not find the "Fac Short Description" filter input.');
    }

    // 7) Search each term and collect rows
    const dedup = new Map();
    for (const term of FAC_TERMS) {
      await shortDescInput.click({ timeout: 3000 }).catch(()=>{});
      await shortDescInput.fill('');
      await shortDescInput.type(term, { delay: 30 });
      await workPage.waitForTimeout(900); // allow grid to refresh
      const rows = await readRowsFrom(card);
      for (const row of rows) {
        const key = row.facCode || row.facShortDesc;
        dedup.set(key, row);
      }
    }

    // 8) Write CSV
    const result = Array.from(dedup.values());
    const outPath = 'gmcc-week.csv';
    fs.writeFileSync(outPath, toCsv(result), 'utf8');
    console.log(`Wrote ${result.length} rows to ${outPath}`);

  } catch (err) {
    console.error('Scrape failed:', err);
    // Try to save something useful from either the popup page or the original
    try { await saveFailureArtifacts(page, 'error'); } catch {}
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
