// scripts/export-reservations.js
import { chromium } from "playwright";
import fs from "fs";
import path from "path";

/* ========= CONFIG ========= */
const FAC_TERMS = ["Community Lounge", "Multi-use Pool", "Full A+B"];

// Required
const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;     // ...#/login
// Optional: a deep link that *sometimes* loads a blank panel. We'll still try it first.
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL || "";

// Derived home route (works even if LOGIN_URL lacks "#/login")
const HOME_URL  = LOGIN_URL?.includes("#/login")
  ? LOGIN_URL.replace("#/login", "#/home")
  : (LOGIN_URL?.split("#")[0] || LOGIN_URL) + "#/home";

const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ========= TIMEOUTS ========= */
const NAV_TIMEOUT = 120_000; // first paint / route changes
const OP_TIMEOUT  = 90_000;  // general UI ops
const LONG_WAIT   = 30_000;

/* ========= UTIL ========= */
async function saveFailureArtifacts(pageLike, label) {
  const page = pageLike.page ? pageLike.page() : pageLike;
  try {
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), "utf8");
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), "utf8");
  } catch {}
}



async function waitOutSpinner(root) {
  const spinner = root.locator('text=/Please\\s+Wait/i').first();
  if (await spinner.isVisible({ timeout: 800 }).catch(() => false)) {
    await spinner.waitFor({ state: "detached", timeout: LONG_WAIT }).catch(() => {});
  }
}

async function clickIfResumePrompt(root) {
  const prompt = root.getByText(/Login Prompts/i).first();
  if (await prompt.isVisible({ timeout: 800 }).catch(() => false)) {
    await root.getByRole("button", { name: /continue/i }).click({ timeout: 8_000 }).catch(() => {});
    await root.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await root.waitForTimeout(600);
  }
}

function parseCsv(text) {
  const rows = [];
  let i = 0, field = "", inQ = false, row = [];
  while (i < text.length) {
    const c = text[i++];
    if (inQ) {
      if (c === '"') {
        if (text[i] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else {
      if (c === '"') inQ = true;
      else if (c === ",") { row.push(field); field = ""; }
      else if (c === "\n") { row.push(field); rows.push(row); row = []; field = ""; }
      else if (c !== "\r") field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function toCsv(rows) {
  const headers = Object.keys(rows[0] || { facClass:"", facLocation:"", facCode:"", facShortDesc:"", status:"" });
  const esc = v => `"${String(v ?? "").replaceAll('"','""')}"`;
  return [headers.join(","), ...rows.map(r => headers.map(h => esc(r[h])).join(","))].join("\n");
}

/* ========= LOGIN / NAV ========= */
async function gotoWithRetries(page, url, label) {
  for (let i = 1; i <= 3; i++) {
    try {
      await page.goto(url, { waitUntil: "commit", timeout: NAV_TIMEOUT });
      await page.waitForLoadState("domcontentloaded", { timeout: 20_000 }).catch(() => {});
      return;
    } catch (e) {
      await saveFailureArtifacts(page, `${label}-goto-${i}`);
      if (i === 3) throw e;
      await page.waitForTimeout(1500);
    }
  }
}

async function fullyLogin(page) {
  const userSel = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
  const passSel = 'input[name="password"], #password, input[type="password"]';
  const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In")';

  await gotoWithRetries(page, LOGIN_URL, "login");

  // Up to 90s: handle whichever step is present
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    await clickIfResumePrompt(page);
    for (const f of page.frames()) await clickIfResumePrompt(f);
    await waitOutSpinner(page);

    if (!page.url().includes('#/login')) break; // past login

    const userField = page.locator(userSel).first();
    const hasLogin = await userField.isVisible({ timeout: 5000 }).catch(() => false);

    if (hasLogin) {
      await userField.fill(USERNAME);
      await page.locator(passSel).first().fill(PASSWORD);
      await Promise.all([
        page.waitForLoadState('networkidle').catch(() => {}),
        page.click(submitSel).catch(() => {})
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
    page.getByRole('link', { name: /facility reservation interface/i }),
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
    return popup; // ← use this page from now on
  }

  // No popup? Keep working in the current page (or an iframe within it)
  return page;
}

async function openFacilityDataGrid(page) {
  // Sometimes the left toolbar has a specific DataGrid tool that must be clicked.
  await waitOutSpinner(page);
  await clickIfResumePrompt(page);

  if (await page.getByText(/Facility DataGrid/i).first().isVisible({ timeout: 1000 }).catch(() => false)) return;

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
    if (await el.isVisible({ timeout: 800 }).catch(() => false)) {
      await el.click().catch(() => {});
      await waitOutSpinner(page);
      break;
    }
  }
}

/* ========= GRID DETECTION / EXPORT ========= */
async function findGridRoot(page) {
  const headerTexts = [/Facility Reservation Interface/i, /Facility DataGrid/i, /Facilities/i];

  const tryRoot = async (root) => {
    await waitOutSpinner(root);
    await clickIfResumePrompt(root);
    for (const rx of headerTexts) {
      if (await root.getByText(rx).first().isVisible({ timeout: 800 }).catch(() => false)) return root;
    }
    // Sometimes the grid is present even if those headers aren't visible; look for a table.
    if (await root.locator('table').first().isVisible({ timeout: 800 }).catch(() => false)) return root;
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

async function openExportMenu(root) {
  console.log("→ Looking for Facility DataGrid table and its header gear button...");
  
  // First, find the actual data table (not the sidebar)
  let dataTableArea = null;
  const tableCandidates = [
    // Look for the table specifically with the facility data
    root.locator('table:has(th:has-text("Fac Class"))'),
    root.locator('table:has(th:has-text("Fac Location"))'),
    root.locator('table:has(th:has-text("Fac Code"))'),
    root.locator('table:has(tbody tr:has(td:has-text("GMCC")))'),
    
    // Look for the container that has both "Facility DataGrid" header AND a table
    root.locator('div:has-text("Facility DataGrid"):has(table)'),
    root.locator('[class*="card"]:has-text("Facility DataGrid"):has(table)'),
  ];
  
  for (const candidate of tableCandidates) {
    if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) {
      dataTableArea = candidate;
      console.log("→ Found data table area");
      break;
    }
  }
  
  if (!dataTableArea) {
    // Fallback: find any table and work from there
    dataTableArea = root.locator('table').first();
    if (await dataTableArea.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log("→ Using fallback table");
    } else {
      console.log("→ No table found, using whole root");
      dataTableArea = root;
    }
  }

  // Now find the container/card that holds this table AND has the "Facility DataGrid" header
  let gridCard = null;
  const gridCardCandidates = [
    // Navigate up from table to find the card with the header
    dataTableArea.locator('xpath=ancestor::div[contains(., "Facility DataGrid")]').first(),
    dataTableArea.locator('xpath=ancestor::*[contains(@class, "card")]').first(),
    
    // Direct search for cards containing both header and table
    root.locator('div:has-text("Facility DataGrid"):has(table)'),
    root.locator('[class*="card"]:has-text("Facility DataGrid"):has(table)'),
    
    // Broader search
    root.locator('div:has-text("Facility DataGrid")').first()
  ];
  
  for (const candidate of gridCardCandidates) {
    if (await candidate.isVisible({ timeout: 1000 }).catch(() => false)) {
      gridCard = candidate;
      console.log("→ Found Facility DataGrid container");
      break;
    }
  }
  
  if (!gridCard) {
    gridCard = dataTableArea;
    console.log("→ Using data table area as grid card");
  }

  // Look specifically for gear button in the header area (top part of the card, near "Facility DataGrid" text)
  console.log("→ Looking for gear/settings button in DataGrid header...");
  const gearCandidates = [
    // Target the specific row with the toolbar icons (gear, expand, refresh, etc.)
    gridCard.locator('div:has(button[class*="settings" i], button[class*="cog" i])').locator('button:has(i[class*="mdi-cog"])').first(),
    
    // Look for the gear in the header row with other action buttons
    gridCard.locator('div:has-text("Facilities")').locator('..').locator('button:has(i[class*="mdi-cog"])').first(),
    
    // Look for buttons specifically near the "Facility DataGrid" text (in header)
    gridCard.locator('div:has-text("Facility DataGrid")').locator('button:has(i[class*="mdi-cog"])').first(),
    gridCard.locator('div:has-text("Facility DataGrid")').locator('button:has(svg)').first(),
    
    // Look in the first button group/row (where the toolbar buttons typically are)
    gridCard.locator('button:has(i[class*="mdi-cog"])').first(),
    gridCard.locator('button:has(svg[class*="cog"])').first(),
    gridCard.locator('button:has(i[class*="settings"])').first(),
    
    // Target buttons by aria-label or title
    gridCard.locator('button[aria-label*="settings" i]').first(),
    gridCard.locator('button[title*="settings" i]').first(),
    
    // Look in what appears to be a header/toolbar area
    gridCard.locator('[class*="header"]').locator('button:has(i[class*="mdi-cog"])').first(),
    gridCard.locator('[class*="toolbar"]').locator('button:has(i[class*="mdi-cog"])').first(),
    gridCard.locator('[class*="card-title"]').locator('button').first()
  ];

  let gearFound = false;
  for (const gear of gearCandidates) {
    try {
      if (await gear.isVisible({ timeout: 1000 }).catch(() => false)) {
        console.log("→ Found gear button in header, clicking...");
        await gear.click({ timeout: 3000 });
        gearFound = true;
        
        // Wait for dropdown menu to appear
        await root.waitForTimeout(1500);
        break;
      }
    } catch (e) {
      console.log(`→ Gear candidate failed: ${e.message}`);
    }
  }

  if (!gearFound) {
    await saveFailureArtifacts(root.page ? root.page() : root, "no-gear-button");
    throw new Error('Could not find the gear/settings button in Facility DataGrid header.');
  }

  // Look for export menu item - focus on dropdown menus that appear after clicking gear
  console.log("→ Looking for Export Comma Delimited in dropdown menu...");
  const menuCandidates = [
    // Standard dropdown menu items
    root.getByRole("menuitem", { name: /export.*comma.*delimited/i }),
    root.getByRole("menuitem", { name: /comma.*delimited/i }),
    root.getByRole("menuitem", { name: /export.*csv/i }),
    
    // Dropdown list items
    root.locator('[role="menu"] >> text=/Export.*Comma.*Delimited/i'),
    root.locator('[role="listbox"] >> text=/Export.*Comma.*Delimited/i'),
    root.locator('ul >> text=/Export.*Comma.*Delimited/i'),
    
    // Generic dropdown items (avoid sidebar elements)
    root.locator('div[role="menu"]:visible').getByText(/export.*comma.*delimited/i).first(),
    root.locator('.dropdown-menu:visible').getByText(/export.*comma.*delimited/i).first(),
    root.locator('[class*="menu"]:visible').getByText(/export.*comma.*delimited/i).first(),
    
    // Broader search in visible dropdown menus
    root.locator('div:has-text("Export"):visible').first()
  ];

  let menuClicked = false;
  for (const menuItem of menuCandidates) {
    try {
      if (await menuItem.isVisible({ timeout: 2000 }).catch(() => false)) {
        console.log("→ Found export menu item in dropdown, clicking...");
        await menuItem.click({ timeout: 3000 });
        menuClicked = true;
        break;
      }
    } catch (e) {
      console.log(`→ Menu candidate failed: ${e.message}`);
    }
  }

  if (!menuClicked) {
    await saveFailureArtifacts(root.page ? root.page() : root, "no-export-menu");
    throw new Error('Could not find the "Export Comma Delimited" menu item in dropdown.');
  }
  
  console.log("→ Successfully clicked export menu item");
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

  const wanted = FAC_TERMS.map(s => s.toLowerCase());
  const out = [];

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    const short = (row[idxShort] || "").toLowerCase();
    if (wanted.some(t => short.includes(t))) {
      out.push({
        facClass:     row[idxClass] ?? "",
        facLocation:  row[idxLoc]   ?? "",
        facCode:      row[idxCode]  ?? "",
        facShortDesc: row[idxShort] ?? "",
        status:       row[idxStat]  ?? ""
      });
    }
  }
  return out;
}

/* ========= MAIN ========= */
(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    acceptDownloads: true,
    locale: "en-US",
    timezoneId: "America/Detroit",
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36",
  });
  context.setDefaultNavigationTimeout(NAV_TIMEOUT);
  context.setDefaultTimeout(OP_TIMEOUT);

  const page = await context.newPage();

  try {
    // 1) Login
    console.log("→ Logging in...");
    await fullyLogin(page);

    // 2) Open the Facility panel (captures popup if RecTrac opens a legacy window)
    console.log("→ Opening Facility Reservation Interface …");
    const workPage = await openFacilityPanel(context, page);

    // 3) If there is a left-toolbar DataGrid tool, click it
    console.log("→ Opening Facility DataGrid...");
    await openFacilityDataGrid(workPage);

    // 4) Find the grid root (page or iframe)
    console.log("→ Locating Facility DataGrid …");
    const root = await findGridRoot(workPage);
    if (!root) {
      await saveFailureArtifacts(workPage, 'no-grid');
      throw new Error('Could not find the Facilities grid. (Panel loaded but DataGrid never appeared.)');
    }

    console.log("→ Exporting CSV from grid …");
    const downloadPromise = workPage.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
    await openExportMenu(root);

    const download = await downloadPromise;
    if (!download) {
      await saveFailureArtifacts(workPage, "no-download");
      throw new Error("Export did not trigger a CSV download.");
    }

    // Read exported CSV
    let tmpPath = await download.path();
    if (!tmpPath) {
      // Some browsers stream—persist it
      const alt = path.resolve(`./${download.suggestedFilename() || "rectrac-export.csv"}`);
      await download.saveAs(alt);
      tmpPath = alt;
    }
    const csvText = fs.readFileSync(tmpPath, "utf8");

    console.log("→ Filtering locally to target facilities …");
    const filtered = filterDownloadedCsv(csvText);
    const outPath = path.resolve("gmcc-week.csv");
    if (filtered.length) {
      fs.writeFileSync(outPath, toCsv(filtered), "utf8");
      console.log(`Wrote ${filtered.length} rows to ${outPath}`);
    } else {
      fs.writeFileSync(
        outPath,
        toCsv([{ facClass:"", facLocation:"", facCode:"", facShortDesc:"", status:"" }]).trim() + "\n",
        "utf8"
      );
      console.log(`Wrote 0 rows to ${outPath} (no matches after export).`);
    }

  } catch (err) {
    console.error("Scrape failed:", err);
    await saveFailureArtifacts(page, "error");
    process.exit(1);
  } finally {
    await browser.close();
  }
})();
