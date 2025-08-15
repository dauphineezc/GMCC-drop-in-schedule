// scripts/export-reservations.js
import { chromium } from 'playwright';
import fs from 'fs';

const FAC_TERMS = [
  'Community Lounge',
  'Multi-use Pool',
  'Full A+B'
];

// CHANGE THESE in GitHub Secrets (or locally in your shell)
const LOGIN_URL  = process.env.RECTRAC_LOGIN_URL;        // e.g. https://rectrac.example.com/RecTrac
const GRID_URL   = process.env.RECTRAC_FACILITY_GRID_URL;// deep link to the Facility DataGrid screen
const USERNAME   = process.env.RECTRAC_USER;
const PASSWORD   = process.env.RECTRAC_PASS;

function toCsv(rows) {
  const headers = Object.keys(rows[0] || {
    facClass: '', facLocation: '', facCode: '', facShortDesc: '', status: ''
  });
  const esc = v => `"${String(v ?? '').replaceAll('"','""')}"`;
  return [
    headers.join(','),
    ...rows.map(r => headers.map(h => esc(r[h])).join(','))
  ].join('\n');
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  // 1) Login
  await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

  // ✅ SELECTORS: adjust these to the actual login form fields/buttons.
  await page.fill('input[name="username"], #username, input[type="text"]', USERNAME);
  await page.fill('input[name="password"], #password, input[type="password"]', PASSWORD);
  await page.click('button[type="submit"], button:has-text("Sign In"), input[type="submit"]');
  await page.waitForLoadState('networkidle');

  // 2) Go to the Facility DataGrid
  await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('text=Facility DataGrid');

  // Helper to read visible rows
  async function readRows() {
    return page.evaluate(() => {
      // SELECTORS: check table structure in your grid (th/td order).
      const rows = Array.from(document.querySelectorAll('table tbody tr'));
      const parsed = [];
      for (const r of rows) {
        const tds = r.querySelectorAll('td');
        if (tds.length < 5) continue;
        parsed.push({
          facClass: tds[0].innerText.trim(),
          facLocation: tds[1].innerText.trim(),
          facCode: tds[2].innerText.trim(),
          facShortDesc: tds[3].innerText.trim(),
          status: tds[4].innerText.trim()
        });
      }
      return parsed;
    });
  }

  // SELECTOR: the “Fac Short Description” filter input
  const SHORT_DESC_FILTER = 'input[aria-label*="Fac Short Description"], input[placeholder*="Short"], input[type="search"]';

  const dedup = new Map(); // key by facCode or shortDesc
  for (const term of FAC_TERMS) {
    // Clear existing filter and type the new term
    await page.fill(SHORT_DESC_FILTER, '');
    await page.type(SHORT_DESC_FILTER, term);
    // Wait for grid to refresh
    await page.waitForTimeout(900);

    // Optionally ensure “Status” filter includes Active
    // (If your Status column has a dropdown, you can set it here.)

    const rows = await readRows();
    for (const row of rows) {
      const key = row.facCode || row.facShortDesc;
      dedup.set(key, row);
    }
  }

  const result = Array.from(dedup.values());

  // 3) Write CSV (weekly file—your calendar expects a fixed name)
  const outPath = 'gmcc-week.csv';
  fs.writeFileSync(outPath, toCsv(result), 'utf8');
  console.log(`Wrote ${result.length} rows to ${outPath}`);

  await browser.close();
})();
