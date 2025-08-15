// scripts/export-reservations.js
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';

const TIMEOUT = 60000;
const FAC_TERMS = ['Community Lounge', 'Multi-use Pool', 'Full A+B'];

const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL;
const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ---------- utils ---------- */
function toCsv(rows) {
  const headers = Object.keys(rows[0] || { });
  const esc = v => `"${String(v ?? '').replaceAll('"','""')}"`;
  return [headers.join(','), ...rows.map(r => headers.map(h => esc(r[h])).join(','))].join('\n');
}

function parseCsv(text) {
  // Tiny CSV parser that handles quoted commas and quotes.
  const out = [];
  let row = [];
  let cell = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], n = text[i+1];
    if (inQ) {
      if (c === '"' && n === '"') { cell += '"'; i++; }
      else if (c === '"') { inQ = false; }
      else { cell += c; }
    } else {
      if (c === '"') inQ = true;
      else if (c === ',') { row.push(cell); cell = ''; }
      else if (c === '\r') { /* ignore */ }
      else if (c === '\n') { row.push(cell); out.push(row); row = []; cell=''; }
      else { cell += c; }
    }
  }
  if (cell.length || row.length) { row.push(cell); out.push(row); }
  return out;
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

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);

    if (!page.url().includes('#/login')) break;

    const userField = page.locator(userSel).first();
    const hasLogin = await userField.isVisible({ timeout: 5000 }).catch(()=>false);

    if (hasLogin) {
      await userField.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(()=>{}),
        page.click(submitSel).catch(()=>{})
      ]);
      continue;
    }

    await page.waitForTimeout(800);
  }

  if (page.url().includes('#/login')) {
    await saveFailureArtifacts(page, 'login-stuck');
    throw new Error('Login did not complete.');
  }
}

async function attachToLegacy(context, page) {
  // We may land on the panel (shell) that injects the legacy UI,
  // or RecTrac might open a popup. Handle both, with a reload fallback.
  const until = Date.now() + 60_000;

  async function tryLocateRoot(p) {
    // Check page and its frames for grid header or recognizable toolbar.
    const headerRx = [/Facility Reservation Interface/i, /Facility DataGrid/i, /Facilities/i];
    const filterSel = 'h1.panel-header, h4:has-text("Facility DataGrid"), .datagrid-header-toolbar';

    const tryRoot = async (root) => {
      await waitOutSpinner(root);
      await clickIfResumePrompt(root);
      for (const rx of headerRx) {
        if (await root.getByText(rx).first().isVisible({ timeout: 800 }).catch(()=>false)) return root;
      }
      if (await root.locator(filterSel).first().isVisible({ timeout: 800 }).catch(()=>false)) return root;
      return null;
    };

    let r = await tryRoot(p);
    if (r) return r;

    for (const f of p.frames()) {
      r = await tryRoot(f);
      if (r) return r;
    }
    return null;
  }

  // Navigate to the grid route first.
  await page.goto(GRID_URL, { waitUntil: 'domcontentloaded' });
  await clickIfResumePrompt(page);

  while (Date.now() < until) {
    // 1) Did a popup open?
    const pop = context.pages().find(pg => pg !== page && /client\.wsc/i.test(pg.url()));
    if (pop) {
      await pop.waitForLoadState('domcontentloaded').catch(()=>{});
      const root = await tryLocateRoot(pop);
      if (root) return { root, page: pop };
    }

    // 2) Is the legacy UI mounted in this tab?
    const rootHere = await tryLocateRoot(page);
    if (rootHere) return { root: rootHere, page };

    // 3) Give it a nudge: sometimes a reload kicks the injector
    await page.waitForTimeout(1000);
    if (Date.now() + 5000 < until) {
      await page.reload({ waitUntil: 'domcontentloaded' }).catch(()=>{});
      await clickIfResumePrompt(page);
    }
  }

  return null;
}

function normalizeHeaderIndex(headers) {
  const map = {};
  headers.forEach((h, i) => { map[h.toLowerCase()] = i; });
  const idx = (nameLike) => {
    const key = Object.keys(map).find(k => k.includes(nameLike.toLowerCase()));
    return key != null ? map[key] : -1;
  };
  return { idx };
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

    // 2) Attach to the legacy grid (popup or same tab), with reload fallback
    const attach = await attachToLegacy(context, page);
    if (!attach) {
      await saveFailureArtifacts(page, 'no-grid');
      throw new Error('Could not find the Facilities grid (blank panel or legacy UI not detected).');
    }
    const { root, page: workPage } = attach;

    // 3) Open the grid Options menu → Export Comma Delimited
    const optionsBtn = root.locator('button.datagrid-tools-menu-button,[title="Options"]').first();
    if (!await optionsBtn.isVisible({ timeout: 8000 }).catch(()=>false)) {
      await saveFailureArtifacts(workPage, 'no-options');
      throw new Error('Could not find the grid Options (gear) button.');
    }

    // Wait for download and click export
    const [download] = await Promise.all([
      workPage.waitForEvent('download', { timeout: 45_000 }),
      (async () => {
        await optionsBtn.click().catch(()=>{});
        const exportItem = root.getByText(/Export Comma Delimited/i).first();
        await exportItem.click({ timeout: 8000 });
      })()
    ]);

    // 4) Save the CSV that RecTrac generates
    const tmpPath = path.resolve('facility-export.csv');
    await download.saveAs(tmpPath);

    // 5) Parse & filter locally (simpler than fighting the column filters)
    const raw = fs.readFileSync(tmpPath, 'utf8');
    const table = parseCsv(raw);
    if (!table.length) throw new Error('Downloaded CSV is empty.');
    const headers = table[0].map(h => h.trim());
    const { idx } = normalizeHeaderIndex(headers);

    const colMap = {
      facClass:      idx('fac class'),
      facLocation:   idx('fac location'),
      facCode:       idx('fac code'),
      facShortDesc:  idx('short desc'),
      status:        idx('status'),
    };

    const rows = table.slice(1).map(r => ({
      facClass:      colMap.facClass >= 0 ? r[colMap.facClass] : '',
      facLocation:   colMap.facLocation >= 0 ? r[colMap.facLocation] : '',
      facCode:       colMap.facCode >= 0 ? r[colMap.facCode] : '',
      facShortDesc:  colMap.facShortDesc >= 0 ? r[colMap.facShortDesc] : '',
      status:        colMap.status >= 0 ? r[colMap.status] : '',
    }));

    const wanted = new Set(FAC_TERMS.map(s => s.toLowerCase()));
    const filtered = rows.filter(r => {
      const s = (r.facShortDesc || '').toLowerCase();
      for (const term of wanted) if (s.includes(term)) return true;
      return false;
    });

    // 6) Dedupe by facCode or short desc
    const dedup = new Map();
    for (const row of filtered) {
      const key = row.facCode || row.facShortDesc;
      dedup.set(key, row);
    }
    const result = [...dedup.values()];

    const outPath = 'gmcc-week.csv';
    const csvOut = toCsv(result);
    fs.writeFileSync(outPath, csvOut, 'utf8');
    console.log(`Wrote ${result.length} rows to ${outPath}`);

  } catch (err) {
    console.error('Scrape failed:', err);
    await saveFailureArtifacts(page, 'error');
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
