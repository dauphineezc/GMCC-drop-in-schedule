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
  console.log("→ Looking for gear/settings button in the entire interface...");
  
  // Instead of limiting ourselves to the table container, let's search the entire root
  // and save screenshots to understand the structure better
  await saveFailureArtifacts(root.page ? root.page() : root, "before-gear-search");
  
  // Count how many different types of buttons/icons exist in the entire interface
  const allGears = root.locator('button:has(i[class*="mdi-cog"]), button:has(svg[class*="cog"]), button:has(i[class*="settings"])');
  const gearCount = await allGears.count();
  console.log(`→ Found ${gearCount} total gear/settings buttons (MDI icons) in the entire interface`);
  
  // Look for other icon patterns that might be the gear
  const svgButtons = root.locator('button:has(svg)');
  const svgButtonCount = await svgButtons.count();
  console.log(`→ Found ${svgButtonCount} total buttons with SVG icons`);
  
  const iconButtons = root.locator('button:has(i)');
  const iconButtonCount = await iconButtons.count();
  console.log(`→ Found ${iconButtonCount} total buttons with <i> icons`);
  
  const smallButtons = root.locator('button[style*="16px"], button[style*="18px"], button[style*="20px"]');
  const smallButtonCount = await smallButtons.count();
  console.log(`→ Found ${smallButtonCount} total small buttons (16-20px)`);
  
  const allButtons = root.locator('button');
  const buttonCount = await allButtons.count();
  console.log(`→ Found ${buttonCount} total buttons in the interface`);
  
  // Debug: Let's log some button details to understand what we're working with
  console.log("→ Analyzing first 10 buttons in the interface:");
  for (let i = 0; i < Math.min(10, buttonCount); i++) {
    const btn = allButtons.nth(i);
    try {
      const btnClass = await btn.getAttribute('class').catch(() => '');
      const btnText = await btn.textContent().catch(() => '');
      const btnHtml = await btn.innerHTML().catch(() => '');
      console.log(`Button ${i}: class="${btnClass}", text="${btnText}", html="${btnHtml.substring(0, 100)}..."`);
    } catch (e) {
      console.log(`Button ${i}: Error - ${e.message}`);
    }
  }

  // Search more specifically for the DataGrid gear icon, excluding sidebar/navigation menus
  const broadGearCandidates = [
    // Look specifically for gear buttons within the DataGrid area (exclude sidebar buttons)
    root.locator('div:has-text("Facility DataGrid")').locator('xpath=ancestor::*[1]').locator('button:has(i[class*="mdi-cog"])').first(),
    root.locator('div:has-text("Facility DataGrid")').locator('xpath=preceding-sibling::*').locator('button:has(i[class*="mdi-cog"])').first(),
    root.locator('div:has-text("Facility DataGrid")').locator('xpath=following-sibling::*').locator('button:has(i[class*="mdi-cog"])').first(),
    
    // Look for toolbar/header areas within the DataGrid card (not sidebar)
    root.locator('div:has-text("Facility DataGrid")').locator('xpath=ancestor::*[contains(@class, "card")]').locator('button:has(i[class*="mdi-cog"])').first(),
    
    // Target buttons specifically near the table/grid, not in sidebar
    root.locator('table').locator('xpath=ancestor::*[1]').locator('button:has(i[class*="mdi-cog"])').first(),
    root.locator('table').locator('xpath=preceding-sibling::*').locator('button:has(i[class*="mdi-cog"])').first(),
    
    // Look for gear icons using CSS selector exclusions (avoiding .not() method)
    root.locator('button:has(i[class*="mdi-cog"]):not(.menu-button):not(.sidebar-icon):not([class*="sidebar"]):not([class*="nav"])').first(),
    root.locator('button:has(svg[class*="cog"]):not(.menu-button):not(.sidebar-icon):not([class*="sidebar"])').first(),
    
    // Simple gear button search (we'll filter manually)
    root.locator('button:has(i[class*="mdi-cog"])').first(),
    root.locator('button:has(svg[class*="cog"])').first()
  ];

  let gearFound = false;
  
  // First try the broad candidates
  for (let i = 0; i < broadGearCandidates.length; i++) {
    const gear = broadGearCandidates[i];
    try {
      if (await gear.isVisible({ timeout: 1000 }).catch(() => false)) {
        const buttonText = await gear.textContent().catch(() => '');
        const buttonClass = await gear.getAttribute('class').catch(() => '');
        const buttonHtml = await gear.innerHTML().catch(() => '');
        console.log(`→ Trying broad gear candidate ${i}: text="${buttonText}", class="${buttonClass}"`);
        console.log(`→ Button HTML: ${buttonHtml.substring(0, 200)}...`);
        
        // Skip known sidebar/navigation buttons
        if (buttonClass && (buttonClass.includes('menu-button') || buttonClass.includes('sidebar-icon') || buttonClass.includes('sidebar') || buttonClass.includes('nav'))) {
          console.log(`→ Skipping broad gear candidate ${i} - appears to be sidebar/navigation button`);
          continue;
        }
        
        // Skip if button text suggests it's a navigation menu
        if (buttonText && (buttonText.toLowerCase().includes('menu') || buttonText.toLowerCase().includes('navigation'))) {
          console.log(`→ Skipping broad gear candidate ${i} - text suggests navigation button`);
          continue;
        }
        
        await gear.click({ timeout: 3000 });
        await root.waitForTimeout(2000);
        
        // Check if a dropdown menu with export options appeared (not navigation menu)
        const hasExportMenu = await root.locator('[role="menu"]:has-text("Export"), .dropdown-menu:has-text("Export"), div:has-text("Export Comma Delimited")').first().isVisible({ timeout: 1000 }).catch(() => false);
        const hasNavigationMenu = await root.locator('[role="menu"]:has-text("Home"), [role="menu"]:has-text("Dashboard"), div:has-text("Navigation")').first().isVisible({ timeout: 500 }).catch(() => false);
        
        if (hasExportMenu) {
          console.log(`→ Successfully clicked broad gear candidate ${i} - export menu appeared!`);
          gearFound = true;
          break;
        } else if (hasNavigationMenu) {
          console.log(`→ Broad gear candidate ${i} opened navigation menu, not export menu - closing and continuing`);
          // Try to close the navigation menu by clicking elsewhere or pressing escape
          await root.press('Escape').catch(() => {});
          await root.waitForTimeout(500);
        } else {
          console.log(`→ Broad gear candidate ${i} clicked but no export menu appeared`);
        }
      }
    } catch (e) {
      console.log(`→ Broad gear candidate ${i} failed: ${e.message}`);
    }
  }
  
  // If broad search didn't work, try a much broader systematic search
  if (!gearFound) {
    console.log("→ Broad search failed, trying ALL possible gear/settings/action buttons...");
    
    // Expand search to include ANY button that might be a settings/action button
    const allPossibleGearButtons = root.locator([
      // Traditional gear patterns
      'button:has(i[class*="mdi-cog"])',
      'button:has(svg[class*="cog"])', 
      'button:has(i[class*="settings"])',
      'button:has(i[class*="mdi-settings"])',
      'button:has(i[class*="gear"])',
      
      // Any SVG button (toolbar icons often use SVG)
      'button:has(svg)',
      
      // Small buttons that might be toolbar icons
      'button[style*="16px"]',
      'button[style*="18px"]', 
      'button[style*="20px"]',
      
      // Buttons with common icon/action classes
      'button[class*="icon"]',
      'button[class*="action"]',
      'button[class*="tool"]',
      
      // Buttons near the DataGrid that might be action buttons
      'div:has-text("Facility DataGrid") button',
      'div:has-text("Facilities") button',
      
      // Any button in what might be a toolbar row
      'button:has(i)',
      'button:has(span.icon)',
      
      // Look for buttons with specific viewBox patterns (common in toolbar SVGs)
      'button:has(svg[viewBox*="16"])',
      'button:has(svg[viewBox*="0 0 16"])'
    ].join(', '));
    
    const totalGears = await allPossibleGearButtons.count();
    console.log(`→ Found ${totalGears} total possible gear/action buttons, trying each systematically...`);
    
    for (let j = 0; j < totalGears; j++) {
      const specificGear = allPossibleGearButtons.nth(j);
      try {
        if (await specificGear.isVisible({ timeout: 500 }).catch(() => false)) {
          const buttonText = await specificGear.textContent().catch(() => '');
          const buttonClass = await specificGear.getAttribute('class').catch(() => '');
          const buttonHtml = await specificGear.innerHTML().catch(() => '');
          console.log(`→ Trying gear button ${j}: text="${buttonText}", class="${buttonClass}"`);
          console.log(`→ Button HTML: ${buttonHtml.substring(0, 150)}...`);
          
          // Skip known sidebar/navigation buttons
          if (buttonClass && (buttonClass.includes('menu-button') || buttonClass.includes('sidebar-icon') || buttonClass.includes('sidebar') || buttonClass.includes('nav'))) {
            console.log(`→ Skipping gear button ${j} - appears to be sidebar/navigation button`);
            continue;
          }
          
          // Skip if button text suggests it's a navigation menu
          if (buttonText && (buttonText.toLowerCase().includes('menu') || buttonText.toLowerCase().includes('navigation'))) {
            console.log(`→ Skipping gear button ${j} - text suggests navigation button`);
            continue;
          }
          
          await specificGear.click({ timeout: 3000 });
          await root.waitForTimeout(2000);
          
          // Check if a dropdown menu with export options appeared (not navigation menu)
          const hasExportMenu = await root.locator('[role="menu"]:has-text("Export"), .dropdown-menu:has-text("Export"), div:has-text("Export Comma Delimited")').first().isVisible({ timeout: 1000 }).catch(() => false);
          const hasNavigationMenu = await root.locator('[role="menu"]:has-text("Home"), [role="menu"]:has-text("Dashboard"), div:has-text("Navigation")').first().isVisible({ timeout: 500 }).catch(() => false);
          
          if (hasExportMenu) {
            console.log(`→ SUCCESS! Gear button ${j} opened the export menu!`);
            gearFound = true;
            break;
          } else if (hasNavigationMenu) {
            console.log(`→ Gear button ${j} opened navigation menu, not export menu - closing and continuing`);
            // Try to close the navigation menu by clicking elsewhere or pressing escape
            await root.press('Escape').catch(() => {});
            await root.waitForTimeout(500);
          } else {
            console.log(`→ Gear button ${j} clicked but no menu appeared`);
          }
        }
      } catch (e) {
        console.log(`→ Gear button ${j} failed: ${e.message}`);
      }
    }
  }

  if (!gearFound) {
    await saveFailureArtifacts(root.page ? root.page() : root, "no-gear-button");
    throw new Error('Could not find the gear/settings button in Facility DataGrid header.');
  }

  // Look for export menu item - focus on dropdown menus that appear after clicking gear
  console.log("→ Looking for Export Comma Delimited in dropdown menu...");
  
  // Wait a bit longer for the menu to fully render
  await root.waitForTimeout(1000);
  
  const menuCandidates = [
    // Target export options specifically within visible dropdown menus (not in table)
    root.locator('[role="menu"]:visible >> text=/Export.*Comma.*Delimited/i'),
    root.locator('[role="menu"]:visible >> text=/comma.*delimited/i'),
    root.locator('[role="menu"]:visible >> text=/export.*csv/i'),
    
    // Target visible dropdown containers with export text
    root.locator('.dropdown-menu:visible >> text=/Export.*Comma.*Delimited/i'),
    root.locator('[class*="menu"]:visible >> text=/Export.*Comma.*Delimited/i'),
    
    // Standard dropdown menu items (with role verification)
    root.getByRole("menuitem", { name: /export.*comma.*delimited/i }),
    root.getByRole("menuitem", { name: /comma.*delimited/i }),
    root.getByRole("menuitem", { name: /export.*csv/i }),
    
    // Target menu items that are definitely in overlays/dropdowns (higher z-index)
    root.locator('[style*="z-index"]:visible >> text=/Export.*Comma.*Delimited/i'),
    root.locator('[class*="overlay"]:visible >> text=/Export.*Comma.*Delimited/i'),
    root.locator('[class*="dropdown"]:visible >> text=/Export.*Comma.*Delimited/i')
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
