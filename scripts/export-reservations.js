import { chromium } from 'playwright';
import fs from 'fs';

const TIMEOUT = 60000;
const FAC_TERMS = ['Community Lounge','Multi-use Pool','Full A+B'];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL;
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

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

(async () => {
  const browser = await chromium.launch({ headless: true }); // use false locally to watch
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(TIMEOUT);

  try {
    // 1) Login
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    // ✅ CHECK THIS SELECTOR: username, password, submit
    await page.fill('input[name="username"], #username, input[type="text"]', USERNAME);
    await page.fill('input[name="password"], #password, input[type="password"]', PASSWORD);
    await Promise.all([
      page.waitForNavigation({ waitUntil: 'networkidle', timeout: TIMEOUT }).catch(()=>{}),
      page.click('button[type="submit"], input[type="submit"], button:has-text("Sign In")')
    ]);

    // 2) Go directly to the Facility DataGrid
    await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });

    // Some RecTrac screens render inside an iframe. Try page first, then any iframe.
    // ✅ CHECK THIS SELECTOR: something near the grid header
    const GRID_HEADER_TEXT = 'Facility DataGrid';
    let root = page;
    try {
      await root.waitForSelector(`text=${GRID_HEADER_TEXT}`, { timeout: 8000 });
    } catch {
      // search iframes
      const frames = page.frames();
      for (const f of frames) {
        try {
          await f.waitForSelector(`text=${GRID_HEADER_TEXT}`, { timeout: 3000 });
          root = f; // found it in this frame
          break;
        } catch { /* keep looking */ }
      }
    }

    // If still not found, dump artifacts and bail with a helpful error
    try {
      await root.waitForSelector(`text=${GRID_HEADER_TEXT}`, { timeout: 5000 });
    } catch {
      await saveFailureArtifacts(page, 'no-grid');
      throw new Error(`Could not find "${GRID_HEADER_TEXT}". Check login, GRID_URL, or that the grid is not behind SSO or a different label.`);
    }

    // ✅ CHECK THIS SELECTOR: the Fac Short Description filter input
    const SHORT_DESC_FILTER = 'input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]';

    // Helper to read visible rows from the grid table (adjust columns if needed)
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

    const dedup = new Map();

    for (const term of FAC_TERMS) {
      // Clear + type filter term
      await root.fill(SHORT_DESC_FILTER, '');                  // clear
      await root.type(SHORT_DESC_FILTER, term);                // type
      await root.waitForTimeout(900);                          // allow refresh
      const rows = await readRows();
      for (const row of rows) {
        const key = row.facCode || row.facShortDesc;
        dedup.set(key, row);
      }
    }

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
