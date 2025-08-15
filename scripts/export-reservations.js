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
  } catch { /* ignore */ }
}

async function clickIfResumePrompt(pageOrFrame) {
  // Handles the "Login Prompts" → "Continue" dialog if present.
  const prompt = pageOrFrame.locator('text=Login Prompts');
  if (await prompt.first().isVisible({ timeout: 1500 }).catch(() => false)) {
    const btn = pageOrFrame.getByRole('button', { name: /continue/i });
    await btn.click({ timeout: 5000 });
    await pageOrFrame.waitForLoadState('networkidle', { timeout: 10000 }).catch(()=>{});
    await pageOrFrame.waitForTimeout(500);
  }
}

async function findGridRoot(page, headerTextCandidates = [
  'Facility Reservation Interface',
  'Facility DataGrid',
  'Facilities'
]) {
  // Look in page, else crawl iframes.
  const tryRoot = async (root) => {
    for (const t of headerTextCandidates) {
      if (await root.locator(`text=${t}`).first().isVisible({ timeout: 1500 }).catch(()=>false)) return root;
    }
    // As a fallback, try to detect the filter input for "Fac Short Description"
    if (await root.locator('input[aria-label*="Short Description"], input[placeholder*="Short"]').first()
      .isVisible({ timeout: 1500 }).catch(()=>false)) return root;
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

/* ---------- main ---------- */
(async () => {
  const browser = await chromium.launch({ headless: true }); // set false locally to watch
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // 1) Open login page
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    // Sometimes the "Resume Session" modal appears even before entering creds.
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);

    // 2) Fill username/password if inputs exist
    const userSel = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
    const passSel = 'input[name="password"], #password, input[type="password"]';

    // If login inputs aren’t visible yet, don’t hang forever—just continue (some SSO flows auto-log you in).
    const userVisible = await page.locator(userSel).first().isVisible({ timeout: 4000 }).catch(()=>false);
    if (userVisible) {
      await page.fill(userSel, USERNAME);
      await page.fill(passSel, PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(()=>{}),
        page.click('button[type="submit"], input[type="submit"], button:has-text("Sign In")')
      ]);
    }

    // 2b) Handle the resume prompt that appears right AFTER login
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);

    // 3) Navigate straight to the Facility Reservation Interface / DataGrid
    await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });

    // Some tenants show the resume prompt again on first app screen
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);

    // 4) Find the grid root (page or iframe)
    const root = await findGridRoot(page);
    if (!root) {
      await saveFailureArtifacts(page, 'no-grid');
      throw new Error('Could not find the Facilities grid. Check that GRID_URL is correct and that you are logged in.');
    }

    // 5) Locate the "Fac Short Description" filter input
    const SHORT_DESC_FILTER =
      'input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]';
    const filterVisible = await root.locator(SHORT_DESC_FILTER).first().isVisible({ timeout: 10000 }).catch(()=>false);
    if (!filterVisible) {
      await saveFailureArtifacts(page, 'no-filter');
      throw new Error('Could not find the "Fac Short Description" filter input.');
    }

    // Helper to read visible rows
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

    // 6) Run each term, collect, dedupe
    const dedup = new Map();
    for (const term of FAC_TERMS) {
      await root.fill(SHORT_DESC_FILTER, '');
      await root.type(SHORT_DESC_FILTER, term);
      await root.waitForTimeout(900);
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
