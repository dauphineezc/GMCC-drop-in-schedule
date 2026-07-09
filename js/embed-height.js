/* Notify the parent page (greatermidland.org) so the iframe can resize to content height. */
const EmbedHeight = (() => {
  const PARENT_ORIGINS = new Set([
    'https://greatermidland.org',
    'https://www.greatermidland.org',
  ]);

  const HEIGHT_BUFFER = 16;

  try {
    if (document.referrer) PARENT_ORIGINS.add(new URL(document.referrer).origin);
  } catch { /* ignore invalid referrer */ }

  function measureHeight() {
    const shell = document.querySelector('.today-shell');
    if (shell) {
      const rect = shell.getBoundingClientRect();
      return Math.ceil(rect.bottom - rect.top + window.scrollY + HEIGHT_BUFFER);
    }
    return Math.ceil(Math.max(
      document.documentElement.scrollHeight,
      document.body.scrollHeight,
      document.documentElement.offsetHeight,
    ) + HEIGHT_BUFFER);
  }

  function reportHeight() {
    if (window.parent === window) return;
    const payload = { type: 'gmcc-schedule-height', height: measureHeight() };
    for (const origin of PARENT_ORIGINS) {
      window.parent.postMessage(payload, origin);
    }
  }

  function reportHeightSoon() {
    requestAnimationFrame(() => requestAnimationFrame(reportHeight));
  }

  function reportHeightBurst() {
    reportHeightSoon();
    [50, 150, 400, 1000].forEach(ms => setTimeout(reportHeight, ms));
  }

  function init() {
    reportHeightBurst();
    window.addEventListener('load', reportHeightBurst);
    window.addEventListener('resize', reportHeightSoon);
    if (document.fonts?.ready) document.fonts.ready.then(reportHeightBurst);
    if (typeof ResizeObserver !== 'undefined') {
      const ro = new ResizeObserver(reportHeightSoon);
      ro.observe(document.body);
      const shell = document.querySelector('.today-shell');
      if (shell) ro.observe(shell);
    }
  }

  init();
  return { reportHeight: reportHeightBurst };
})();
