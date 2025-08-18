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

async function processExport(root) {
  console.log("→ Looking for Process button to trigger export...");
  
  // Save screenshot to understand the interface before clicking Process
  await saveFailureArtifacts(root.page ? root.page() : root, "before-process-button");
  
  // Look for Process button - should be in the lower area of the interface
  const processButtons = root.locator('button:has-text("Process"), input[type="button"][value*="Process"], button[value*="Process"]');
  const processCount = await processButtons.count();
  console.log(`→ Found ${processCount} total Process buttons in the interface`);
  
  const allButtons = root.locator('button, input[type="button"], input[type="submit"]');
  const buttonCount = await allButtons.count();
  console.log(`→ Found ${buttonCount} total buttons/inputs in the interface`);
  
  // Debug: Let's log some button details to understand what we're working with
  console.log("→ Analyzing first 15 buttons in the interface:");
  for (let i = 0; i < Math.min(15, buttonCount); i++) {
    const btn = allButtons.nth(i);
    try {
      const btnClass = await btn.getAttribute('class').catch(() => '');
      const btnText = await btn.textContent().catch(() => '');
      const btnValue = await btn.getAttribute('value').catch(() => '');
      const btnType = await btn.getAttribute('type').catch(() => '');
      console.log(`Button ${i}: type="${btnType}", class="${btnClass}", text="${btnText}", value="${btnValue}"`);
    } catch (e) {
      console.log(`Button ${i}: Error - ${e.message}`);
    }
  }

  // Search for Process button with various patterns
  const processButtonCandidates = [
    // Direct text matches for Process button
    root.locator('button:has-text("Process")').first(),
    root.locator('input[type="button"][value="Process"]').first(),
    root.locator('input[type="submit"][value="Process"]').first(),
    root.locator('button[value="Process"]').first(),
    
    // Case insensitive and partial matches
    root.locator('button:has-text("process")').first(),
    root.locator('input[value*="Process" i]').first(),
    root.locator('button:has-text("PROCESS")').first(),
    
    // Look in lower area of interface (common location for Process buttons)
    root.locator('div:last-child').locator('button:has-text("Process")').first(),
    root.locator('[class*="footer"], [class*="bottom"], [class*="actions"]').locator('button:has-text("Process")').first(),
    
    // Look near other action buttons like "Last Settings", "Schedule" 
    root.locator('button:has-text("Last Settings")').locator('..').locator('button:has-text("Process")').first(),
    root.locator('button:has-text("Schedule")').locator('..').locator('button:has-text("Process")').first(),
    root.locator('button:has-text("Default Settings")').locator('..').locator('button:has-text("Process")').first()
  ];

  let processFound = false;
  
  // First try the process button candidates
  for (let i = 0; i < processButtonCandidates.length; i++) {
    const processBtn = processButtonCandidates[i];
    try {
      if (await processBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
        const buttonText = await processBtn.textContent().catch(() => '');
        const buttonClass = await processBtn.getAttribute('class').catch(() => '');
        const buttonValue = await processBtn.getAttribute('value').catch(() => '');
        console.log(`→ Trying process button candidate ${i}: text="${buttonText}", class="${buttonClass}", value="${buttonValue}"`);
        
        await processBtn.click({ timeout: 3000 });
        await root.waitForTimeout(3000); // Wait longer for processing to start
        
        // Check if success popup appeared
        const hasSuccessPopup = await root.locator('div:has-text("Success"), div:has-text("Process sent to server"), div:has-text("Complete")').first().isVisible({ timeout: 5000 }).catch(() => false);
        const hasFinishedPopup = await root.locator('div:has-text("Finished"), div:has-text("Process is Complete")').first().isVisible({ timeout: 3000 }).catch(() => false);
        
        if (hasSuccessPopup || hasFinishedPopup) {
          console.log(`→ Successfully clicked process button candidate ${i} - success popup appeared!`);
          processFound = true;
          break;
        } else {
          console.log(`→ Process button candidate ${i} clicked but no success popup appeared`);
        }
      }
    } catch (e) {
      console.log(`→ Process button candidate ${i} failed: ${e.message}`);
    }
  }
  
  // If targeted search didn't work, try a broader systematic search for any Process button
  if (!processFound) {
    console.log("→ Targeted search failed, trying ALL possible Process buttons...");
    
    // Search for ANY button that might contain "Process" text
    const allPossibleProcessButtons = root.locator([
      // Direct text searches
      'button:has-text("Process")',
      'input[value*="Process"]',
      'button[value*="Process"]',
      
      // Case variations
      'button:has-text("process")',
      'button:has-text("PROCESS")',
      'input[value*="process" i]',
      
      // Buttons that might be Process buttons
      'button:has-text("Run")',
      'button:has-text("Execute")',
      'button:has-text("Submit")',
      'button:has-text("Generate")',
      'button:has-text("Export")',
      
      // Any button element that might be a process button
      'button',
      'input[type="button"]',
      'input[type="submit"]'
    ].join(', '));
    
    const totalProcess = await allPossibleProcessButtons.count();
    console.log(`→ Found ${totalProcess} total possible process buttons, trying each systematically...`);
    
    for (let j = 0; j < totalProcess; j++) {
      const specificProcess = allPossibleProcessButtons.nth(j);
      try {
        if (await specificProcess.isVisible({ timeout: 500 }).catch(() => false)) {
          const buttonText = await specificProcess.textContent().catch(() => '');
          const buttonClass = await specificProcess.getAttribute('class').catch(() => '');
          const buttonValue = await specificProcess.getAttribute('value').catch(() => '');
          console.log(`→ Trying process button ${j}: text="${buttonText}", class="${buttonClass}", value="${buttonValue}"`);
          
          // Skip if button text doesn't suggest it could be a process button
          if (buttonText && !buttonText.toLowerCase().match(/process|run|execute|submit|generate|export|start|go/)) {
            console.log(`→ Skipping process button ${j} - text doesn't suggest process action`);
            continue;
          }
          
          await specificProcess.click({ timeout: 3000 });
          await root.waitForTimeout(3000);
          
          // Check if success popup appeared
          const hasSuccessPopup = await root.locator('div:has-text("Success"), div:has-text("Process sent to server"), div:has-text("Complete")').first().isVisible({ timeout: 5000 }).catch(() => false);
          const hasFinishedPopup = await root.locator('div:has-text("Finished"), div:has-text("Process is Complete")').first().isVisible({ timeout: 3000 }).catch(() => false);
          
          if (hasSuccessPopup || hasFinishedPopup) {
            console.log(`→ SUCCESS! Process button ${j} triggered the processing!`);
            processFound = true;
            break;
          } else {
            console.log(`→ Process button ${j} clicked but no success popup appeared`);
          }
        }
      } catch (e) {
        console.log(`→ Process button ${j} failed: ${e.message}`);
      }
    }
  }

  if (!processFound) {
    await saveFailureArtifacts(root.page ? root.page() : root, "no-process-button");
    throw new Error('Could not find the Process button to trigger export.');
  }

  // Handle the success popups and wait for document download
  console.log("→ Handling success popups and waiting for document download...");
  
  // Wait for and handle success popup
  await root.waitForTimeout(2000);
  
  // Look for "Preview Document" or download link in the popup
  const previewButton = root.locator('button:has-text("Preview Document"), a:has-text("Preview Document"), div:has-text("Preview Document")').first();
  if (await previewButton.isVisible({ timeout: 3000 }).catch(() => false)) {
    console.log("→ Found Preview Document button, clicking...");
    await previewButton.click({ timeout: 3000 });
  }
  
  // Close any success popups by clicking Close button or clicking outside
  const closeButton = root.locator('button:has-text("Close"), button[aria-label="Close"]').first();
  if (await closeButton.isVisible({ timeout: 2000 }).catch(() => false)) {
    console.log("→ Closing success popup...");
    await closeButton.click({ timeout: 3000 });
  }
  
  console.log("→ Process button clicked successfully, waiting for download to start...");
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

    console.log("→ Processing export from interface …");
    const downloadPromise = workPage.waitForEvent("download", { timeout: 60_000 }).catch(() => null);
    await processExport(root);

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
