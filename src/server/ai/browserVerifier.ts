import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { log } from '../logger.js';
import { loadEncryptedJson } from '../services/checkoutProfile.js';

let browserInstance: Browser | null = null;
let idleTimer: NodeJS.Timeout | null = null;
let launchPromise: Promise<Browser | null> | null = null;
let activeBrowserLeases = 0;

const IDLE_CLOSE_MS = 60_000;

function resetIdleTimer(): void {
  if (idleTimer) clearTimeout(idleTimer);
  if (activeBrowserLeases > 0) return;
  idleTimer = setTimeout(() => {
    if (activeBrowserLeases === 0) {
      void closePlaywrightBrowser();
    }
  }, IDLE_CLOSE_MS);
  idleTimer.unref?.();
}

export async function closePlaywrightBrowser(): Promise<void> {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  if (browserInstance) {
    const b = browserInstance;
    browserInstance = null;
    await b.close().catch(() => undefined);
    log.info('Playwright', 'Zamknięto nieaktywną przeglądarkę Headless Chromium.');
  }
}

async function getBrowser(): Promise<Browser | null> {
  if (browserInstance && browserInstance.isConnected()) {
    resetIdleTimer();
    return browserInstance;
  }
  if (launchPromise) return launchPromise;

  launchPromise = (async () => {
    try {
      log.info('Playwright', 'Uruchamiam Headless Chromium do weryfikacji ofert...');
      const browser = await chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-blink-features=AutomationControlled',
        ],
      });
      browserInstance = browser;
      resetIdleTimer();
      return browser;
    } catch (err) {
      log.warn(
        'Playwright',
        'Nie udało się uruchomić Chromium — używam trybu HTTP fallback.',
        err instanceof Error ? err.message : String(err)
      );
      return null;
    } finally {
      launchPromise = null;
    }
  })();

  return launchPromise;
}

export async function acquirePlaywrightBrowser(): Promise<Browser | null> {
  activeBrowserLeases += 1;
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const browser = await getBrowser();
  if (!browser) {
    activeBrowserLeases = Math.max(0, activeBrowserLeases - 1);
    return null;
  }
  return browser;
}

export function releasePlaywrightBrowser(): void {
  activeBrowserLeases = Math.max(0, activeBrowserLeases - 1);
  if (activeBrowserLeases === 0) {
    resetIdleTimer();
  }
}

async function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

async function waitForCdpReady(port: number, timeoutMs = 8_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (res.ok) return;
    } catch {
      // Wait for Chrome CDP listener
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('Nie udało się połączyć z oknem Chromium (timeout CDP).');
}

export interface SavedFormFieldSnapshot {
  tag: 'input' | 'select' | 'textarea';
  name: string;
  id: string;
  type: string;
  value: string;
  checked?: boolean;
}

export interface CheckoutHandoffPayload {
  origin: string;
  sessionStorage: Array<[string, string]>;
  formFields: SavedFormFieldSnapshot[];
}

export function handoffSidecarPath(storageStatePath: string): string {
  return storageStatePath.replace(/\.json$/i, '') + '.handoff.enc';
}

interface SavedStorageState {
  cookies?: Parameters<Awaited<ReturnType<Browser['newContext']>>['addCookies']>[0];
  origins?: Array<{
    origin: string;
    localStorage: Array<{ name: string; value: string }>;
  }>;
}

export async function restoreStateIntoContext(
  ctx: BrowserContext,
  storageStatePath?: string | null
): Promise<CheckoutHandoffPayload | null> {
  if (!storageStatePath) return null;

  let handoff: CheckoutHandoffPayload | null = null;
  try {
    const raw = await fs.readFile(storageStatePath, 'utf8');
    const state = JSON.parse(raw) as SavedStorageState;
    if (state.cookies && state.cookies.length > 0) {
      await ctx.addCookies(state.cookies);
    }

    handoff = await loadEncryptedJson<CheckoutHandoffPayload>(
      handoffSidecarPath(storageStatePath)
    );

    const originMap: Record<string, Array<{ name: string; value: string }>> = {};
    for (const o of state.origins ?? []) {
      originMap[o.origin] = o.localStorage;
    }

    const sessionMap: Record<string, Array<[string, string]>> = {};
    if (handoff && handoff.origin && handoff.sessionStorage.length > 0) {
      sessionMap[handoff.origin] = handoff.sessionStorage;
    }

    if (Object.keys(originMap).length > 0 || Object.keys(sessionMap).length > 0) {
      await ctx.addInitScript(
        ({ localMap, sessMap }) => {
          const localItems = localMap[window.location.origin];
          if (Array.isArray(localItems)) {
            for (const item of localItems) {
              try {
                window.localStorage.setItem(item.name, item.value);
              } catch {
                // Ignore storage quota errors
              }
            }
          }
          const sessItems = sessMap[window.location.origin];
          if (Array.isArray(sessItems)) {
            for (const [k, v] of sessItems) {
              try {
                window.sessionStorage.setItem(k, v);
              } catch {
                // Ignore storage quota errors
              }
            }
          }
        },
        { localMap: originMap, sessMap: sessionMap }
      );
    }
  } catch (err) {
    log.warn('Playwright', 'Nie udało się odtworzyć storageState w oknie handoff', {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  return handoff;
}

async function applySingleSavedField(
  page: Page,
  field: SavedFormFieldSnapshot
): Promise<boolean> {
  const selector = field.name
    ? `${field.tag}[name="${field.name.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"]`
    : field.id
      ? `#${field.id.replace(/[^a-zA-Z0-9_-]/g, '\\$&')}`
      : '';
  if (!selector) return false;

  const loc = page.locator(selector).first();
  if ((await loc.count()) === 0) return false;

  const isVisible = await loc.isVisible().catch(() => false);
  if (!isVisible) return false;

  try {
    if (field.tag === 'select') {
      await loc.selectOption(field.value, { timeout: 2_000 }).catch(() => undefined);
      return true;
    }
    if (field.type === 'checkbox' || field.type === 'radio') {
      if (field.checked) {
        await loc.check({ timeout: 2_000 }).catch(() => undefined);
      }
      return true;
    }
    const current = (await loc.inputValue({ timeout: 1_500 }).catch(() => '')).trim();
    if (current && current !== '@' && current === field.value.trim()) {
      return true;
    }
    await loc
      .evaluate((el) => {
        el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      })
      .catch(() => undefined);
    try {
      await loc.fill(field.value, { timeout: 2_500 });
    } catch {
      await loc.fill(field.value, { force: true, timeout: 2_000 });
    }
    await loc.blur().catch(() => undefined);
    return true;
  } catch {
    return false;
  }
}

export async function replayHandoffFormFields(
  page: Page,
  handoff: CheckoutHandoffPayload | null
): Promise<void> {
  if (!handoff || handoff.formFields.length === 0) return;
  await page.waitForTimeout(800);

  // Pass 1: apply e-mail / primary fields first to trigger progressive-disclosure forms
  const primary = handoff.formFields.filter(
    (f) => /email|e-mail/i.test(f.name) || /email/i.test(f.id) || f.type === 'email'
  );
  const rest = handoff.formFields.filter((f) => !primary.includes(f));

  let restoredCount = 0;
  for (const f of primary) {
    if (await applySingleSavedField(page, f)) restoredCount += 1;
  }

  if (primary.length > 0 && rest.length > 0) {
    await page.waitForTimeout(1_500);
  }

  // Pass 2: fill revealed address, phone, name, checkboxes, etc.
  for (const f of rest) {
    if (await applySingleSavedField(page, f)) restoredCount += 1;
  }

  log.info('Playwright', 'Odtworzono pola formularza w widocznym oknie handoff', {
    savedFields: handoff.formFields.length,
    restoredFields: restoredCount,
  });
}

export async function launchVisibleCheckoutWindow(
  checkoutUrl: string,
  storageStatePath?: string | null
): Promise<void> {
  log.info(
    'Playwright',
    `Otwieram widoczne okno przeglądarki do płatności: ${checkoutUrl}`
  );

  // On Windows, launching Chromium directly from an IDE/background terminal can inherit SW_HIDE
  // (hiding the window from the taskbar). Launching via `cmd.exe /d /c start "" /MAX` resets STARTUPINFO
  // so Windows shows a real visible taskbar window, and Playwright connects over CDP to restore the cart state.
  if (process.platform === 'win32') {
    const exePath = chromium.executablePath();
    const port = await getFreePort();
    const userDataDir = path.join(
      os.tmpdir(),
      `consiler-win-${crypto.randomUUID().slice(0, 8)}`
    );
    await fs.mkdir(userDataDir, { recursive: true });

    const launcher = spawn(
      'cmd.exe',
      [
        '/d',
        '/c',
        'start',
        '""',
        '/MAX',
        exePath,
        `--user-data-dir=${userDataDir}`,
        `--remote-debugging-port=${port}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-blink-features=AutomationControlled',
        'about:blank',
      ],
      { detached: true, stdio: 'ignore', windowsHide: false }
    );
    launcher.unref();

    await waitForCdpReady(port, 10_000);
    const cdpBrowser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    try {
      const ctx = cdpBrowser.contexts()[0];
      const handoff = await restoreStateIntoContext(ctx, storageStatePath);

      const page = ctx.pages()[0] || (await ctx.newPage());
      await page.bringToFront().catch(() => undefined);
      await page.goto(checkoutUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 25_000,
      });
      await replayHandoffFormFields(page, handoff);
      await page.bringToFront().catch(() => undefined);
    } finally {
      // Closing a connectOverCDP browser only disconnects CDP; the visible Chrome window stays open!
      await cdpBrowser.close().catch(() => undefined);
    }
    return;
  }

  const visibleBrowser = await chromium.launch({
    headless: false,
    args: ['--start-maximized', '--disable-blink-features=AutomationControlled'],
  });

  const context = await visibleBrowser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: null,
  });
  const handoff = await restoreStateIntoContext(context, storageStatePath);

  const page = await context.newPage();
  await page.bringToFront().catch(() => undefined);
  await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 25_000 });
  await replayHandoffFormFields(page, handoff);
  await page.bringToFront().catch(() => undefined);

  visibleBrowser.on('disconnected', () => {
    log.info('Playwright', 'Użytkownik zamknął widoczne okno checkoutu.');
  });
}

export interface BrowserFetchResult {
  finalUrl: string;
  httpStatus: number | null;
  title: string;
  bodyText: string;
}

export async function fetchRenderedPageWithPlaywright(
  url: string,
  timeoutMs = 14_000
): Promise<BrowserFetchResult | null> {
  const browser = await acquirePlaywrightBrowser();
  if (!browser) return null;

  const context = await browser.newContext({
    locale: 'pl-PL',
    timezoneId: 'Europe/Warsaw',
    viewport: { width: 1280, height: 800 },
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  });

  try {
    const page = await context.newPage();
    // Skip heavy assets to keep verification fast
    await page.route('**/*', (route) => {
      const type = route.request().resourceType();
      if (type === 'image' || type === 'media' || type === 'font') {
        return route.abort();
      }
      return route.continue();
    });

    const response = await page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: timeoutMs,
    });

    // Brief settle window for JS redirects / SPA price & stock rendering
    await page.waitForTimeout(900);

    const finalUrl = page.url() || url;
    const httpStatus = response ? response.status() : null;
    const title = (await page.title().catch(() => '')) || '';
    const bodyText = await page
      .evaluate(() => document.body?.innerText || '')
      .catch(() => '');

    return {
      finalUrl,
      httpStatus,
      title: title.trim(),
      bodyText: bodyText.replace(/\s+/g, ' ').trim(),
    };
  } catch (err) {
    log.warn('Playwright', `Błąd renderowania ${url}`, {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    await context.close().catch(() => undefined);
    releasePlaywrightBrowser();
  }
}
