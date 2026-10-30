/**
 * Visual verification harness for the RapidAid themes (§28).
 *
 * Drives the real app in Chrome: signs in with the seeded demo admin, then
 * walks every major screen in each theme and writes a screenshot plus a health
 * record (applied `data-theme`, computed page background, console errors).
 *
 *   node scripts/theme-visual-check.mjs
 *
 * Output: scripts/theme-shots/<theme>/<page>.png  + report.json
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = join(here, 'theme-shots');

const BASE = process.env.THEME_CHECK_URL ?? 'http://localhost:3000';
const CHROME =
  process.env.CHROME_PATH ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const THEMES = ['command-pulse', 'northstar-os', 'aether-command', 'rescue-glass', 'warm-ivory'];

/** §28 — every screen named in the acceptance list, plus the landing page. */
const SCREENS = [
  { name: 'landing', path: '/' },
  { name: 'login', path: '/login' },
  { name: 'command-center', path: '/command-center' },
  { name: 'emergencies', path: '/emergencies' },
  { name: 'emergency-detail', path: '/emergencies/EMG-001' },
  { name: 'ambulances', path: '/ambulances' },
  { name: 'hospitals', path: '/hospitals' },
  { name: 'tracking', path: '/tracking' },
  { name: 'ai-vision', path: '/ai-vision' },
  { name: 'voice', path: '/voice' },
  { name: 'alerts', path: '/alerts' },
  { name: 'reports', path: '/reports' },
  { name: 'settings', path: '/settings' },
  { name: 'audit', path: '/audit' },
  { name: 'user-management', path: '/admin/users' },
];

const report = [];

async function waitForServer(url, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { method: 'GET' });
      if (res.ok || res.status < 500) return true;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

async function main() {
  const clientUp = await waitForServer(BASE);
  if (!clientUp) {
    console.error(`Client not reachable at ${BASE} — start it with: npm run dev`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROME,
    headless: true,
    args: ['--disable-dev-shm-usage', '--no-sandbox'],
  });

  try {
    for (const theme of THEMES) {
      const themeDir = join(outDir, theme);
      mkdirSync(themeDir, { recursive: true });

      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      // Seed the theme BEFORE the bundle runs — exercises the flash guard path.
      await context.addInitScript((id) => {
        try {
          localStorage.setItem(
            'rapidaid-theme',
            JSON.stringify({ state: { themeId: id, mode: 'dark' }, version: 0 }),
          );
        } catch {
          /* ignore */
        }
      }, theme);

      const page = await context.newPage();
      const consoleErrors = [];
      page.on('console', (m) => {
        if (m.type() === 'error') consoleErrors.push(m.text());
      });
      page.on('pageerror', (e) => consoleErrors.push(String(e)));

      const capture = async (screen, target) => {
        await target.goto(`${BASE}${screen.path}`, { waitUntil: 'domcontentloaded' });
        await target.waitForTimeout(1500);
        const file = join(themeDir, `${screen.name}.png`);
        await target.screenshot({ path: file });
        const meta = await target.evaluate(() => ({
          dataTheme: document.documentElement.getAttribute('data-theme'),
          dataGlow: document.documentElement.getAttribute('data-glow'),
          darkClass: document.documentElement.classList.contains('dark'),
          colorScheme: getComputedStyle(document.documentElement).colorScheme,
          bodyBg: getComputedStyle(document.body).backgroundColor,
          bodyColor: getComputedStyle(document.body).color,
          path: location.pathname,
        }));
        const ok = meta.dataTheme === theme;
        report.push({ theme, screen: screen.name, path: screen.path, ok, meta, file });
        console.log(
          `${ok ? 'OK  ' : 'FAIL'} ${theme.padEnd(15)} ${screen.name.padEnd(18)} ` +
            `bg=${meta.bodyBg} at ${meta.path}`,
        );
      };

      // --- Pass A: public screens, before signing in -----------------------
      await capture(SCREENS[0], page);
      await capture(SCREENS[1], page);

      // --- Sign in as the seeded admin ------------------------------------
      await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(600);
      await page.fill('input[type="email"]', 'admin@rapidaid.com');
      await page.fill('input[type="password"]', 'demo123');
      await page.click('#role');
      await page.getByRole('option', { name: /administrator/i }).click();
      await page.getByRole('button', { name: /sign in/i }).click();
      await page
        .waitForURL((u) => !u.pathname.startsWith('/login'), { timeout: 25_000 })
        .catch(() => {});
      await page.waitForTimeout(1000);
      console.log(`  ${theme}: signed in -> ${page.url()}`);

      // --- Pass B: authenticated screens ----------------------------------
      for (const screen of SCREENS.slice(2)) {
        await capture(screen, page);
      }

      // --- Pass C: theme popover, open over the page action bar ------------
      // A floating menu must stay readable even when it overlaps a bright
      // control (the red Emergency button), so the panel's real fill is
      // recorded alongside the screenshot rather than eyeballed only.
      await page.goto(`${BASE}/emergencies`, { waitUntil: 'domcontentloaded' });
      await page.waitForTimeout(900);
      await page.locator('[data-testid="theme-button"]').click();
      await page.waitForTimeout(600);
      const popoverFile = join(themeDir, 'header-popover.png');
      await page.screenshot({ path: popoverFile });
      const popoverMeta = await page.evaluate(() => {
        const root = getComputedStyle(document.documentElement);
        const panel = document.querySelector('[data-radix-popper-content-wrapper] > *');
        const styles = panel ? getComputedStyle(panel) : null;
        return {
          glass: root.getPropertyValue('--glass').trim(),
          glassElevated: root.getPropertyValue('--glass-elevated').trim(),
          panelBackground: styles?.backgroundColor ?? null,
          panelBlur: styles?.backdropFilter ?? styles?.webkitBackdropFilter ?? null,
        };
      });
      const popoverOk = popoverMeta.panelBackground !== null && popoverMeta.glassElevated !== '';
      report.push({
        theme,
        screen: 'header-popover',
        path: '/emergencies',
        ok: popoverOk,
        meta: popoverMeta,
        file: popoverFile,
      });
      console.log(
        `${popoverOk ? 'OK  ' : 'FAIL'} ${theme.padEnd(15)} ${'header-popover'.padEnd(18)} ` +
          `panel=${popoverMeta.panelBackground} blur=${popoverMeta.panelBlur} ` +
          `--glass-elevated=${popoverMeta.glassElevated}`,
      );
      await page.keyboard.press('Escape');
      await page.waitForTimeout(300);


      // Settings selector on a phone-sized viewport (§32).
      const mobile = await context.newPage();
      await mobile.setViewportSize({ width: 390, height: 844 });
      await mobile.goto(`${BASE}/settings`, { waitUntil: 'domcontentloaded' });
      await mobile.waitForTimeout(900);
      await mobile.screenshot({ path: join(themeDir, 'settings-mobile.png') });
      await mobile.close();

      writeFileSync(
        join(outDir, `console-${theme}.json`),
        JSON.stringify(consoleErrors, null, 2),
        'utf8',
      );
      console.log(`  ${theme}: ${consoleErrors.length} console error(s)`);
      await context.close();
    }
  } finally {
    await browser.close();
  }

  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2), 'utf8');
  const failures = report.filter((r) => !r.ok);
  console.log(`\n${report.length} captures, ${failures.length} theme-application failure(s)`);
  if (failures.length) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
