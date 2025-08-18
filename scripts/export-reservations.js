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

const isLogin = (url) => /#\/login/i.test(url);
const isHome  = (url) => /#\/home/i.test(url);
const isFacilityInterface = (url) => /facility.*reservation|reservation.*facility|#\/panel\/.*\/legacy/i.test(url);

// More robust state detection functions
async function detectPageState(page) {
  const url = page.url();
  console.log(`Detecting state for URL: ${url}`);
  
  // Check for login page elements
  const hasLoginForm = await page.locator('input[name="username"], #username, input[type="text"][autocomplete*=username]')
    .isVisible({ timeout: 2000 }).catch(() => false);
  
  // Check for login prompt/resume session dialog
  const hasLoginPrompt = await page.getByText(/Login Prompts/i).first()
    .isVisible({ timeout: 1000 }).catch(() => false);
  
  // Check for facility grid elements - multiple patterns
  let hasFacilityGrid = false;
  try {
    const checks = await Promise.allSettled([
      page.getByText(/Facility.*DataGrid|Facility Reservation Interface/i).first().isVisible({ timeout: 1500 }),
      page.locator('div:has-text("Facility DataGrid")').first().isVisible({ timeout: 1000 }),
      page.locator('[class*="grid"], [class*="data-grid"], table').first().isVisible({ timeout: 1000 }),
      page.locator('input[aria-label*="Short Description"], input[placeholder*="Short"]').first().isVisible({ timeout: 1000 }),
      page.locator('button:has(i[class*="mdi-cog"])').first().isVisible({ timeout: 1000 }) // settings gear button
    ]);
    hasFacilityGrid = checks.some(result => result.status === 'fulfilled' && result.value === true);
  } catch (e) {
    hasFacilityGrid = false;
  }
  
  // Check for home page elements (favorites, main dashboard)
  const hasHomeFavorites = await page.getByText(/facility reservation interface/i).first()
    .isVisible({ timeout: 2000 }).catch(() => false);
  
  // Determine state based on URL and content
  let state = 'unknown';
  
  if (hasLoginForm || isLogin(url)) {
    state = hasLoginPrompt ? 'login_prompt' : 'login_form';
  } else if (hasFacilityGrid || isFacilityInterface(url)) {
    state = 'facility_interface';
  } else if (hasHomeFavorites || isHome(url)) {
    state = 'home_page';
  } else {
    // Try to detect by URL patterns if content detection fails
    if (isLogin(url)) state = 'login_form';
    else if (isHome(url)) state = 'home_page';
    else if (isFacilityInterface(url)) state = 'facility_interface';
    else if (url.includes('/panel/') && url.includes('/legacy')) {
      // Special case: panel/legacy URLs are likely facility interface even if content isn't loaded yet
      console.log('→ Detected panel/legacy URL pattern, waiting for content to load...');
      await page.waitForTimeout(3000); // Give legacy interface time to load
      
      // Re-check for facility grid content after waiting
      try {
        const delayedGridCheck = await Promise.allSettled([
          page.getByText(/Facility.*DataGrid|Facility Reservation Interface/i).first().isVisible({ timeout: 2000 }),
          page.locator('input[aria-label*="Short Description"], input[placeholder*="Short"]').first().isVisible({ timeout: 2000 }),
          page.locator('button:has(i[class*="mdi-cog"])').first().isVisible({ timeout: 2000 })
        ]);
        const hasDelayedGrid = delayedGridCheck.some(result => result.status === 'fulfilled' && result.value === true);
        
        if (hasDelayedGrid) {
          console.log('→ Confirmed facility grid content after delay');
        } else {
          console.log('→ No facility grid content found even after delay, but URL suggests facility interface');
        }
      } catch (e) {
        console.log('→ Error checking delayed grid content, but URL suggests facility interface');
      }
      
      state = 'facility_interface';
    }
  }
  
  console.log(`Detected state: ${state} (hasLoginForm: ${hasLoginForm}, hasLoginPrompt: ${hasLoginPrompt}, hasFacilityGrid: ${hasFacilityGrid}, hasHomeFavorites: ${hasHomeFavorites})`);
  return state;
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

async function ensureLoggedInOnHome(page) {
  // 1) Always start from the login route to get a clean session.
  await gotoWithRetries(page, LOGIN_URL, "login");
  await page.waitForTimeout(1000); // Allow page to settle

  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const state = await detectPageState(page);
    
    switch (state) {
      case 'login_prompt':
        console.log("→ Handling login prompt/resume session dialog");
        await clickIfResumePrompt(page);
        await waitOutSpinner(page);
        await page.waitForTimeout(1000);
        break;
        
      case 'login_form':
        console.log("→ Submitting login credentials");
        const userSel   = 'input[name="username"], #username, input[type="text"][autocomplete*=username]';
        const passSel   = 'input[name="password"], #password, input[type="password"]';
        const submitSel = 'button[type="submit"], input[type="submit"], button:has-text("Sign In")';
        
        const userField = page.locator(userSel).first();
        if (await userField.isVisible({ timeout: 2000 }).catch(() => false)) {
          await userField.fill(USERNAME);
          await page.locator(passSel).first().fill(PASSWORD);
          await Promise.all([
            page.waitForLoadState("networkidle").catch(() => {}),
            page.click(submitSel).catch(() => {})
          ]);
          await page.waitForTimeout(2000); // Wait for redirect
        } else {
          await page.waitForTimeout(1000);
        }
        break;
        
      case 'facility_interface':
        console.log("→ Already on facility interface, navigating to home first");
        await gotoWithRetries(page, HOME_URL, "home-from-facility");
        break;
        
      case 'home_page':
        console.log("→ Successfully reached home page");
        return; // We're done!
        
      default:
        console.log(`→ Unknown state '${state}', trying to navigate to home`);
        // If we're not on login but not clearly on home either, try going to home
        if (!isLogin(page.url())) {
          await gotoWithRetries(page, HOME_URL, "home-fallback");
          await page.waitForTimeout(1000);
        } else {
          await page.waitForTimeout(1000);
        }
        break;
    }
  }

  // Final state check
  const finalState = await detectPageState(page);
  if (finalState !== 'home_page') {
    await saveFailureArtifacts(page, `login-failed-final-state-${finalState}`);
    throw new Error(`Login did not complete successfully. Final state: ${finalState}`);
  }
}

async function openFacilityPanel(context, page) {
  // At this point we guarantee we're on #/home
  console.log("→ Attempting to open facility panel");
  
  // First try the direct grid route if provided (sometimes blank—handled later)
  if (GRID_URL) {
    try {
      console.log("→ Trying direct GRID_URL");
      await page.goto(GRID_URL, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT });
      await clickIfResumePrompt(page);
      await waitOutSpinner(page);
      await page.waitForTimeout(2000);
      
      // Check if we actually reached the facility interface
      const state = await detectPageState(page);
      if (state === 'facility_interface') {
        console.log("→ Successfully opened facility interface via direct URL");
        return page;
      }
      console.log(`→ Direct URL failed, current state: ${state}`);
    } catch (e) {
      console.log(`→ Direct URL failed with error: ${e.message}`);
    }
  }

  // If direct URL failed or not provided, go back to home and use favorites
  const currentState = await detectPageState(page);
  if (currentState !== 'home_page') {
    console.log("→ Not on home page, navigating there first");
    await gotoWithRetries(page, HOME_URL, "home-before-favorites");
    await page.waitForTimeout(1000);
  }

  // Prepare for a popup before clicking anything
  const popupPromise = context.waitForEvent("page", { timeout: 15_000 }).catch(() => null);

  // Click the "Facility Reservation Interface" favorite (card/tile or link)
  console.log("→ Looking for Facility Reservation Interface favorite");
  const candidates = [
    page.getByRole("button", { name: /facility reservation interface/i }),
    page.getByRole("link",   { name: /facility reservation interface/i }),
    page.locator(':is(div,button,a):has-text("Facility Reservation Interface")').first()
  ];
  
  let clicked = false;
  for (const c of candidates) {
    if (await c.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log("→ Found and clicking facility interface favorite");
      await c.click({ trial: false }).catch(() => {});
      clicked = true;
      break;
    }
  }
  
  if (!clicked) {
    await saveFailureArtifacts(page, "no-facility-favorite");
    throw new Error("Could not find Facility Reservation Interface favorite on home page");
  }

  // Wait a moment for navigation or popup
  await page.waitForTimeout(3000);

  const popup = await popupPromise;
  if (popup) {
    console.log("→ Facility interface opened in popup window");
    await popup.waitForLoadState("domcontentloaded").catch(() => {});
    await clickIfResumePrompt(popup);
    await waitOutSpinner(popup);
    
    // Verify popup actually has facility interface
    const popupState = await detectPageState(popup);
    if (popupState !== 'facility_interface') {
      await saveFailureArtifacts(popup, `popup-wrong-state-${popupState}`);
      throw new Error(`Popup opened but has wrong state: ${popupState}`);
    }
    
    return popup; // legacy window
  }

  // Check if facility interface opened in same tab
  const finalState = await detectPageState(page);
  if (finalState === 'facility_interface') {
    console.log("→ Facility interface opened in same tab");
    return page;
  }
  
  await saveFailureArtifacts(page, `facility-open-failed-${finalState}`);
  throw new Error(`Failed to open facility interface. Final state: ${finalState}`);
}

/* ========= GRID DETECTION / EXPORT ========= */
async function findGridRoot(workPage) {
  const headerRx = /Facility Reservation Interface/i;
  const gridTitleRx = /Facility DataGrid/i;
  const filterSel = 'input[aria-label*="Short Description"], input[placeholder*="Short"], input[type="search"]';

  async function tryRoot(root) {
    await clickIfResumePrompt(root);
    await waitOutSpinner(root);

    const hasHeader = await root.getByText(headerRx).first()
      .isVisible({ timeout: 800 }).catch(() => false);
    const hasGridTitle = await root.getByText(gridTitleRx).first()
      .isVisible({ timeout: 800 }).catch(() => false);
    if (hasHeader && hasGridTitle) return root;

    if (await root.locator(filterSel).first().isVisible({ timeout: 800 }).catch(() => false)) return root;
    return null;
  }

  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let r = await tryRoot(workPage);
    if (r) return r;
    for (const f of workPage.frames()) {
      r = await tryRoot(f);
      if (r) return r;
    }
    // Nudge the tab if it exists
    const tab = workPage.getByRole("tab", { name: headerRx }).first();
    if (await tab.isVisible({ timeout: 300 }).catch(() => false)) {
      await tab.click().catch(() => {});
    }
    await workPage.waitForTimeout(700);
  }
  return null;
}

async function openExportMenu(root) {
  // The gear lives in the grid card header; click "Export Comma Delimited"
  const card = root.locator(
    'div:has(> .v-card-title:has-text("Facility DataGrid")), div:has-text("Facility DataGrid")'
  ).first();

  const gearCandidates = [
    card.getByRole("button", { name: /settings/i }),
    card.locator('button[aria-label*="Settings" i]'),
    card.locator('button:has(i[class*="mdi-cog"])'),
    card.locator('i[class*="mdi-cog"]').first().locator('xpath=ancestor::button[1]')
  ];

  let opened = false;
  for (const c of gearCandidates) {
    if (await c.isVisible({ timeout: 800 }).catch(() => false)) {
      await c.click().catch(() => {});
      opened = true;
      break;
    }
  }
  if (!opened) {
    await card.locator("button").first().click({ timeout: 2000 }).catch(() => {});
  }

  // Click the export item (menuitem or list entry)
  const menuItem = root.getByRole("menuitem", { name: /export.*comma/i }).first();
  if (await menuItem.isVisible({ timeout: 3000 }).catch(() => false)) {
    await menuItem.click().catch(() => {});
    return;
  }
  const alt = root.locator('div[role="menu"] >> text=/Export\\s+Comma\\s+Delimited/i').first();
  if (await alt.isVisible({ timeout: 1500 }).catch(() => false)) {
    await alt.click().catch(() => {});
    return;
  }

  await saveFailureArtifacts(root.page ? root.page() : root, "no-export-menu");
  throw new Error('Could not open the "Export Comma Delimited" menu.');
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
    console.log("→ Ensuring we're logged in and on #/home …");
    await ensureLoggedInOnHome(page);

    console.log("→ Opening Facility Reservation Interface …");
    const workPage = await openFacilityPanel(context, page);

    console.log("→ Locating Facility DataGrid …");
    
    // First verify we're actually on the facility interface
    const workPageState = await detectPageState(workPage);
    if (workPageState !== 'facility_interface') {
      await saveFailureArtifacts(workPage, `wrong-state-before-grid-${workPageState}`);
      throw new Error(`Expected to be on facility interface, but current state is: ${workPageState}`);
    }
    
    let root = await findGridRoot(workPage);
    if (!root) {
      console.log("→ Grid not found, trying soft reload");
      // Soft reload can wake a blank panel
      await workPage.reload({ waitUntil: "domcontentloaded" }).catch(() => {});
      await waitOutSpinner(workPage);
      await workPage.waitForTimeout(2000);
      
      // Verify state after reload
      const reloadState = await detectPageState(workPage);
      if (reloadState !== 'facility_interface') {
        await saveFailureArtifacts(workPage, `wrong-state-after-reload-${reloadState}`);
        throw new Error(`After reload, expected facility interface but got: ${reloadState}`);
      }
      
      root = await findGridRoot(workPage);
    }
    if (!root) {
      await saveFailureArtifacts(workPage, "no-grid");
      throw new Error("Could not find the Facilities grid (blank panel or legacy UI not detected).");
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
