// scripts/export-reservations.js
import { chromium } from "playwright";
import fs from "fs";
import path from "path";
import { S3Client, PutObjectCommand } from "@aws-sdk/client-s3";

const S3_BUCKET = process.env.S3_BUCKET;
const AWS_REGION = process.env.AWS_REGION;

const s3 = new S3Client({ region: AWS_REGION });

/* ========= CONFIG ========= */
const FAC_TERMS = ["Community Lounge", "Multi-use Pool", "Full A+B"];

// Required
const LOGIN_URL = process.env.RECTRAC_LOGIN_URL;     // ...#/login
// Optional: a deep link that *sometimes* loads a blank panel. We'll still try it first.
const GRID_URL  = process.env.RECTRAC_FACILITY_GRID_URL || "";

const USERNAME  = process.env.RECTRAC_USER;
const PASSWORD  = process.env.RECTRAC_PASS;

/* ========= TIMEOUTS ========= */
const NAV_TIMEOUT = 120_000; // first paint / route changes
const OP_TIMEOUT  = 90_000;  // general UI ops
const LONG_WAIT   = 30_000;

/* ========= UTIL ========= */

// ---- CSV capture helpers ----
const csvHits = []; // store any csv-ish responses we see

function looksCsvish(resp) {
  const url = resp.url();
  const h = resp.headers();
  const ct = (h["content-type"] || "").toLowerCase();
  const cd = (h["content-disposition"] || "").toLowerCase();

  // Heuristics: common content types + filename hints + url hints
  const ctCsv = /\bcsv\b/.test(ct) || /\bexcel\b/.test(ct) || /octet-stream/.test(ct);
  const cdCsv = /filename=.*\.csv/.test(cd);
  const urlCsv = /\.csv(\?|$)/i.test(url) || /export|report|download/i.test(url);

  return resp.ok() && (ctCsv || cdCsv || urlCsv);
}

function installCsvSniffer(context) {
  context.on("response", async (resp) => {
    try {
      if (!looksCsvish(resp)) return;
      const buf = await resp.body().catch(() => null);
      console.log(`→ Captured CSV-ish response:
  url=${resp.url()}
  ct=${resp.headers()["content-type"] || ""}
  cd=${resp.headers()["content-disposition"] || ""}
  bytes=${buf?.length ?? 0}`);
      if (buf?.length) csvHits.push({ buf, url: resp.url(), headers: resp.headers() });
    } catch {}
  });
}

async function flushCsvHitToS3() {
  if (!csvHits.length) return false;
  const { buf } = csvHits[csvHits.length - 1];

  // Filter using your existing pipeline
  const csvText = buf.toString("utf8");
  const filtered = filterDownloadedCsv(csvText);
  const outText = filtered.length
    ? toCsv(filtered)
    : (toCsv([{ facClass:"", facLocation:"", facCode:"", facShortDesc:"", status:"" }]).trim() + "\n");

  await uploadCsvBufferToS3(Buffer.from(outText, "utf8"), "gmcc-week.csv");
  return true;
}

// ---- UI overlay cleanup (unblocks the bell click) ----
async function nukeOverlays(page) {
  // Work on page + any frames
  const roots = [page, ...page.frames()];
  for (const r of roots) {
    try { await r.keyboard.press("Escape"); } catch {}
    try {
      await r.locator('.ui-dialog .ui-dialog-titlebar-close, .ui-dialog button:has-text("Close"), [role="dialog"] button:has-text("Close"), [role="dialog"] button:has-text("OK")')
            .first().click({ timeout: 1000 });
    } catch {}
    try {
      await r.evaluate(() => {
        document.querySelectorAll('.ui-widget-overlay, .ui-widget-overlay.skipwidget')
          .forEach(el => el.remove());
      });
    } catch {}
  }
}

async function saveFailureArtifacts(pageLike, label) {
  const page = pageLike.page ? pageLike.page() : pageLike;
  try {
    await page.screenshot({ path: `playwright-${label}.png`, fullPage: true });
    fs.writeFileSync(`playwright-${label}.html`, await page.content(), "utf8");
    fs.writeFileSync(`playwright-${label}.url.txt`, page.url(), "utf8");
  } catch {}
}

async function uploadCsvBufferToS3(buf, key = "gmcc-week.csv") {
// NOTE: do NOT set ACL here (your bucket uses "Bucket owner enforced")
await s3.send(new PutObjectCommand({
    Bucket: S3_BUCKET,
    Key: key,
    Body: buf,
    ContentType: "text/csv",
    CacheControl: "no-cache",
}));
console.log(`→ Uploaded to s3://${S3_BUCKET}/${key}`);
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

async function chooseRelativeDate(root, fieldLabel, optionText) {
    // Find the field container by its <label>
    const container = root.locator('div').filter({
        has: root.locator(`label:has-text("${fieldLabel}")`)
    }).first();

    // The “Actual Date” dropdown trigger inside that container
    const trigger = container.locator('button.ui-datetime-date-option, button:has-text("Actual Date")').first();

    await trigger.scrollIntoViewIfNeeded().catch(() => {});
    await trigger.click({ force: true }); // open the jQuery UI menu

    // Prefer the menu inside the same document as `root` (frame-safe)
    let menu = root.locator('ul.ui-menu[aria-hidden="false"], ul.ui-menu:visible').first();

    // If not visible yet, scan page + frames for a visible menu as a fallback
    if (!(await menu.isVisible({ timeout: 1500 }).catch(() => false))) {
        const page = root.page ? root.page() : null;
        const scopes = page ? [page, ...page.frames()] : [];
        for (const s of scopes) {
        const m = s.locator('ul.ui-menu[aria-hidden="false"], ul.ui-menu:visible').first();
        if (await m.isVisible({ timeout: 200 }).catch(() => false)) { menu = m; break; }
        }
    }

    // If we have a visible menu, pick the option
    if (await menu.isVisible({ timeout: 500 }).catch(() => false)) {
        let item = menu.getByRole('menuitem', { name: new RegExp(`^${optionText}$`, 'i') }).first();
        if (!(await item.isVisible().catch(() => false))) {
        item = menu.locator('li[role="menuitem"], .ui-menu-item')
                    .filter({ hasText: new RegExp(`^${optionText}$`, 'i') })
                    .first();
        }
        await item.click().catch(() => {});
        await (root.page ? root.page() : root).keyboard.press('Escape').catch(() => {}); // close cleanly
        await root.waitForTimeout(150);
        return;
    }

    // Last-resort fallback: fill the date text input directly
    const input = container.locator('input[type="text"], input').first();
    const d = new Date();
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    const yyyy = d.getFullYear();
    const todayText = `${mm}/${dd}/${yyyy}`;      // RecTrac typically uses MM/DD/YYYY
    await input.fill(todayText);
    await input.blur().catch(() => {});
    await root.waitForTimeout(150);
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

async function accessNotificationCenter(page) {
  console.log("→ Attempting to access notification center...");
  
  try {
    // Look for the notification bell icon in the left sidebar
    // Based on the screenshot, it's a sidebar button with notification icon
    const notificationSelectors = [
      // Target the notification button/icon in sidebar
      'button[aria-label*="Notification" i]',
      'button[title*="Notification" i]',
      'button.sidebar-icon.notification-button',
      'button.notifications',
      
      // Look for notification bell/icon
      'button:has(svg[class*="svg-icon"]):has-text("")', // Notification icons often have no text
      'button[class*="notification"]',
      
      // Generic sidebar button targeting
      '.sidebar button:has(svg)',
      '.ng-sidebar button[aria-label*="Notification"]',
      
      // Target by the specific structure from HTML
      'button[class*="sidebar-icon"][class*="notification"]',
      'div[class*="ng-sidebar"] button:has(svg)',
      
      // Most generic - any button in sidebar area
      'aside button, nav button, .sidebar button'
    ];
    
    let notificationButton = null;
    for (const selector of notificationSelectors) {
      const button = page.locator(selector).first();
      if (await button.isVisible({ timeout: 2000 }).catch(() => false)) {
        // Check if this looks like a notification button
        const ariaLabel = await button.getAttribute('aria-label').catch(() => '');
        const title = await button.getAttribute('title').catch(() => '');
        const className = await button.getAttribute('class').catch(() => '');
        
        if (ariaLabel.toLowerCase().includes('notification') || 
            title.toLowerCase().includes('notification') ||
            className.toLowerCase().includes('notification')) {
          console.log(`→ Found notification button with selector: ${selector}`);
          notificationButton = button;
          break;
        }
      }
    }
    
    if (!notificationButton) {
      console.log("→ Could not find notification button, trying sidebar buttons systematically...");
      // Try clicking buttons in sidebar area that might be notifications
      const sidebarButtons = page.locator('.sidebar button, aside button, nav button, .ng-sidebar button');
      const buttonCount = await sidebarButtons.count();
      console.log(`→ Found ${buttonCount} sidebar buttons to try`);
      
      for (let i = 0; i < Math.min(buttonCount, 10); i++) {
        const btn = sidebarButtons.nth(i);
        const btnText = await btn.textContent().catch(() => '');
        const btnClass = await btn.getAttribute('class').catch(() => '');
        const btnAria = await btn.getAttribute('aria-label').catch(() => '');
        
        console.log(`→ Sidebar button ${i}: text="${btnText}", class="${btnClass}", aria="${btnAria}"`);
        
        // Look for buttons that might be notifications
        if (btnAria.toLowerCase().includes('notification') || 
            btnClass.toLowerCase().includes('notification') ||
            btnText.toLowerCase().includes('notification')) {
          notificationButton = btn;
          console.log(`→ Found potential notification button ${i}`);
          break;
        }
      }
    }
    
    if (!notificationButton) {
      console.log("→ Could not locate notification center button");
      return null;
    }
    
    // Click the notification button to open notification center
    console.log("→ Clicking notification button to open notification center...");
    await notificationButton.click();
    await page.waitForTimeout(2000);
    
    // Look for notification panel/dropdown
    const notificationPanel = page.locator('div:has-text("Notifications"), .notification-panel, .notifications-dropdown, [class*="notification"][class*="panel"]').first();
    
    if (!(await notificationPanel.isVisible({ timeout: 5000 }).catch(() => false))) {
      console.log("→ Notification panel did not appear after clicking button");
      return null;
    }
    
    console.log("→ Notification panel opened, looking for latest FacilityReservationInterface document...");
    
    // Look for the latest notification about FacilityReservationInterface process completion
    const facilityNotifications = notificationPanel.locator('div:has-text("FacilityReservationInterface"), div:has-text("Process is Complete")');
    const notificationCount = await facilityNotifications.count();
    console.log(`→ Found ${notificationCount} facility reservation notifications`);
    
    if (notificationCount === 0) {
      console.log("→ No FacilityReservationInterface notifications found");
      return null;
    }
    
    // Click on the most recent (first) notification
    const latestNotification = facilityNotifications.first();
    console.log("→ Clicking on latest FacilityReservationInterface notification...");
    
    // Look for "Preview Document" button within the notification
    const previewButton = latestNotification.locator('button:has-text("Preview Document"), a:has-text("Preview Document")').first();
    
    if (await previewButton.isVisible({ timeout: 3000 }).catch(() => false)) {
      console.log("→ Found 'Preview Document' button, clicking to download...");
      
      // Wait for download to start
      const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
      await previewButton.click();
      
      try {
        const download = await downloadPromise;
        console.log("→ Successfully downloaded document from notification center");
        return download;
      } catch (e) {
        console.log(`→ Download from notification center failed: ${e.message}`);
        return null;
      }
    } else {
      console.log("→ Could not find 'Preview Document' button in notification");
      
      // Try clicking on the notification itself to see if it expands
      await latestNotification.click();
      await page.waitForTimeout(1000);
      
      // Try again to find Preview Document button
      const expandedPreviewButton = page.locator('button:has-text("Preview Document"), a:has-text("Preview Document")').first();
      if (await expandedPreviewButton.isVisible({ timeout: 3000 }).catch(() => false)) {
        console.log("→ Found 'Preview Document' button after expanding notification, clicking...");
        
        const downloadPromise = page.waitForEvent("download", { timeout: 30000 });
        await expandedPreviewButton.click();
        
        try {
          const download = await downloadPromise;
          console.log("→ Successfully downloaded document from expanded notification");
          return download;
        } catch (e) {
          console.log(`→ Download from expanded notification failed: ${e.message}`);
          return null;
        }
      }
    }
    
    return null;
    
  } catch (error) {
    console.log(`→ Error accessing notification center: ${error.message}`);
    return null;
  }
}

async function setDateRanges(root) {
    console.log("→ Setting Begin Date = Today, End Date = Today …");

    try { await (root.page ? root.page() : root).keyboard.press('Escape'); } catch {}

    await chooseRelativeDate(root, "Begin Date", "Today");
    await chooseRelativeDate(root, "End Date",   "Today");

    await saveFailureArtifacts(root.page ? root.page() : root, "dates-after-set");
    await root.waitForTimeout(300);
}

async function processExport(root) {
  console.log("→ Looking for Process button to trigger export...");
  
  // First set the date ranges
  await setDateRanges(root);
  
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

  // Handle the success popups and wait for document processing
  console.log("→ Handling success popups and waiting for document processing...");
  
  // Wait for processing popup to appear
  await root.waitForTimeout(3000);
  
  // The error shows a dialog is intercepting clicks, so let's handle it properly
  console.log("→ Looking for and closing success dialog...");
  
  // First, try to close the dialog using various methods
  const dialogCloseAttempts = [
    // Standard close buttons
    root.locator('.ui-dialog').locator('button:has-text("Close")'),
    root.locator('.ui-dialog').locator('button[aria-label="Close"]'),
    root.locator('.ui-dialog').locator('.ui-dialog-titlebar-close'),
    root.locator('[role="dialog"]').locator('button:has-text("Close")'),
    
    // OK buttons in success dialogs
    root.locator('.ui-dialog').locator('button:has-text("OK")'),
    root.locator('[role="dialog"]').locator('button:has-text("OK")'),
    
    // X close buttons
    root.locator('.ui-dialog').locator('button.ui-dialog-titlebar-close'),
    root.locator('.ui-dialog').locator('span.ui-icon-closethick')
  ];
  
  let dialogClosed = false;
  for (const closeBtn of dialogCloseAttempts) {
    if (await closeBtn.isVisible({ timeout: 1000 }).catch(() => false)) {
      console.log("→ Found dialog close button, clicking...");
      await closeBtn.click({ timeout: 3000 }).catch(() => {});
      dialogClosed = true;
      await root.waitForTimeout(1000);
      break;
    }
  }
  
  // If no close button found, try pressing Escape
  if (!dialogClosed) {
    console.log("→ No close button found, trying Escape key...");
    await (root.page ? root.page() : root).keyboard.press('Escape').catch(() => {});
    await root.waitForTimeout(1000);
  }
  
  // The popup mentions "Check the notification center for completed processes"
  // Let's look for notification center or completed document
  console.log("→ Looking for notification center or completed document...");
  
  const notificationElements = [
    root.locator('div:has-text("notification center")'),
    root.locator('[class*="notification"], [class*="alert"], [class*="message"]'),
    root.locator('div:has-text("completed"), div:has-text("finished"), div:has-text("ready")'),
    root.locator('a[href*=".csv"], a[href*=".pdf"], a[href*="download"]')
  ];
  
  for (const notification of notificationElements) {
    if (await notification.isVisible({ timeout: 2000 }).catch(() => false)) {
      console.log("→ Found notification/download element, attempting to click...");
      await notification.click({ timeout: 3000 }).catch(() => {});
      await root.waitForTimeout(2000);
    }
  }
  
  console.log("→ Process completed, waiting for potential download or checking for document links...");
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
  installCsvSniffer(context);
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
    // Extend timeout for server-side processing
    const downloadPromise = workPage.waitForEvent("download", { timeout: 120_000 }).catch(() => null);
    await processExport(root);

    // Try to catch the CSV bytes directly from the network and upload to S3
    // Give the server a moment to kick off the job
    console.log("→ Polling for captured CSV network response …");
    const csvDeadline = Date.now() + 120_000;
    while (Date.now() < csvDeadline && csvHits.length === 0) {
    await workPage.waitForTimeout(500);
    }
    if (await flushCsvHitToS3()) {
    console.log("→ Uploaded CSV from network capture. Done.");
    return;
    }

    // Wait longer for server-side processing to complete
    console.log("→ Waiting for server-side processing and download...");
    await workPage.waitForTimeout(10_000);
    
    let download = await downloadPromise;
    if (!download) {
      console.log("→ No direct download detected, checking for alternative download methods...");
      
      // Look for download links that might have appeared
      const downloadLinks = workPage.locator('a[href*=".csv"], a[href*=".pdf"], a[href*="download"], a:has-text("download")');
      const linkCount = await downloadLinks.count();
      console.log(`→ Found ${linkCount} potential download links`);
      
      if (linkCount > 0) {
        console.log("→ Attempting to click download link...");
        const secondDownloadPromise = workPage.waitForEvent("download", { timeout: 30_000 }).catch(() => null);
        await downloadLinks.first().click().catch(() => {});
        const secondDownload = await secondDownloadPromise;
        if (secondDownload) {
          console.log("→ Successfully triggered download via link");
          // Continue with this download
          download = secondDownload;
        }
      }
      
      if (!download) {
        console.log("→ Attempting to retrieve document from notification center...");
        await nukeOverlays(workPage);
        download = await accessNotificationCenter(workPage);
      }
      
      if (!download) {
        await saveFailureArtifacts(workPage, "no-download");
        console.log("→ Document may have been sent to S3 bucket or notification center instead of direct download");
        console.log("→ Check your S3 bucket or RecTrac notification center for the processed document");
        // Don't throw error - the process may have succeeded but gone to S3
        return;
      }
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
