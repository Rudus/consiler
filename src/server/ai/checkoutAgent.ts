import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Type } from '@google/genai';
import type { Locator, Page } from 'playwright';
import { z } from 'zod';
import { config, ensureDataDirs } from '../config.js';
import {
  createCheckoutSession,
  getCheckoutSession,
  getTaskDetail,
  updateCheckoutSession,
} from '../db.js';
import { postCheckoutSummaryToDiscordThread } from '../discord/bridge.js';
import { eventBus } from '../events.js';
import { log } from '../logger.js';
import { loadCheckoutProfile, saveEncryptedJson } from '../services/checkoutProfile.js';
import type { CheckoutProfile, CheckoutSession, TaskDetail } from '../types.js';
import {
  acquirePlaywrightBrowser,
  handoffSidecarPath,
  launchVisibleCheckoutWindow,
  releasePlaywrightBrowser,
  type CheckoutHandoffPayload,
  type SavedFormFieldSnapshot,
} from './browserVerifier.js';
import { generateWithTimeout, getGenAI } from './client.js';
import { assertSafePublicUrl, sanitizeUrlPathSlashes } from './webExtractor.js';

const FORBIDDEN_PAYMENT_PATTERNS: RegExp[] = [
  /kupuj[eę]\s*i\s*p[lł]ac[eę]/i,
  /zamawiam\s*(z\s*obowi[aą]zkiem\s*zap[lł]aty|i\s*p[lł]ac[eę])/i,
  /zako[nń]cz\s*(zam[oó]wienie\s*)?i\s*zap[lł]a[cć]/i,
  /potwierdz(am)?\s*(zakup|zam[oó]wienie\s*i\s*p[lł]ac[eę])/i,
  /^\s*zap[lł]a[cć](\s+teraz|\s+online|\s*\d+.*)?\s*$/i,
  /\b(place\s*order|pay\s*now|complete\s*purchase|complete\s*order|submit\s*order|confirm\s*and\s*pay)\b/i,
];

export function isForbiddenPaymentButton(text: string): boolean {
  const normalized = text.replace(/\s+/g, ' ').trim();
  if (!normalized) return false;
  return FORBIDDEN_PAYMENT_PATTERNS.some((rx) => rx.test(normalized));
}

export function resolveProfilePlaceholder(
  rawValue: string,
  profile: CheckoutProfile
): string {
  const nameParts = profile.fullName.trim().split(/\s+/);
  const firstName = nameParts[0] ?? '';
  const lastName = nameParts.slice(1).join(' ') || firstName;

  const map: Record<string, string> = {
    '{{FULL_NAME}}': profile.fullName,
    '{{FIRST_NAME}}': firstName,
    '{{LAST_NAME}}': lastName,
    '{{EMAIL}}': profile.email,
    '{{PHONE}}': profile.phone,
    '{{STREET}}': profile.street,
    '{{POSTAL_CODE}}': profile.postalCode,
    '{{CITY}}': profile.city,
    '{{LOCKER}}': profile.preferredLocker,
    '{{NOTES}}': profile.notes,
  };

  let out = rawValue;
  for (const [token, val] of Object.entries(map)) {
    out = out.split(token).join(val);
  }
  return out;
}

export function matchShippingProfileField(
  meta: {
    name: string;
    id: string;
    autocomplete: string;
    label: string;
    placeholder: string;
    type: string;
  },
  profile: CheckoutProfile
): { key: string; value: string } | null {
  const inputType = (meta.type || '').toLowerCase();
  if (
    ['submit', 'button', 'hidden', 'reset', 'file', 'image', 'password', 'checkbox', 'radio', 'search'].includes(
      inputType
    )
  ) {
    return null;
  }

  const combined = `${meta.name} ${meta.id} ${meta.label} ${meta.placeholder}`.toLowerCase();
  if (
    /search|szukaj|coupon|kupon|promo|rabat|voucher|gift|kod.?rabat|company|firma|nip|regon|newsletter|captcha|blik|card|cvv|cvc|iban/i.test(
      combined
    )
  ) {
    return null;
  }

  const nameParts = profile.fullName.trim().split(/\s+/);
  const firstName = nameParts[0] ?? '';
  const lastName = nameParts.slice(1).join(' ') || firstName;
  const ac = (meta.autocomplete || '').trim().toLowerCase();

  const pick = (key: string, val: string) => (val.trim() ? { key, value: val } : null);

  if (ac === 'email') return pick('EMAIL', profile.email);
  if (ac === 'given-name') return pick('FIRST_NAME', firstName);
  if (ac === 'family-name') return pick('LAST_NAME', lastName);
  if (ac === 'name') return pick('FULL_NAME', profile.fullName);
  if (ac === 'tel' || ac === 'tel-national') return pick('PHONE', profile.phone);
  if (ac === 'street-address' || ac === 'address-line1') return pick('STREET', profile.street);
  if (ac === 'postal-code') return pick('POSTAL_CODE', profile.postalCode);
  if (ac === 'address-level2') return pick('CITY', profile.city);

  if (inputType === 'email' || /\b(e-?mail|mail)\b/i.test(combined)) {
    return pick('EMAIL', profile.email);
  }
  if (/nazwisk|surname|last.?name|family.?name/i.test(combined)) {
    return pick('LAST_NAME', lastName);
  }
  if (/imi[eę].{0,6}nazwisk|full.?name/i.test(combined)) {
    return pick('FULL_NAME', profile.fullName);
  }
  if (/imi[eę]|first.?name|given.?name|\[name\]/i.test(combined)) {
    return pick('FIRST_NAME', firstName);
  }
  if (/telefon|phone|kom[oó]rk|mobile|\btel\b/i.test(combined)) {
    return pick('PHONE', profile.phone);
  }
  if (/kod.?poczt|postal.?code|postalcode|\bzip\b/i.test(combined)) {
    return pick('POSTAL_CODE', profile.postalCode);
  }
  if (/miasto|miejscow|\bcity\b|\btown\b/i.test(combined)) {
    return pick('CITY', profile.city);
  }
  if (/paczkomat|locker|punkt.?odbior/i.test(combined)) {
    return pick('LOCKER', profile.preferredLocker);
  }
  if (/ulic|street|adres(?!.*e-?mail)|address[-_]?1/i.test(combined)) {
    return pick('STREET', profile.street);
  }

  return null;
}

export function parsePlnAmount(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/\s+/g, '').replace(',', '.');
  const match = cleaned.match(/(\d+(?:\.\d{1,2})?)/);
  if (!match) return null;
  const num = Number(match[1]);
  return Number.isFinite(num) ? num : null;
}

const CHALLENGE_TEXT_PATTERNS: RegExp[] = [
  /weryfikujemy twoje po[łl][ąa]czenie/i,
  /potwierd[źz],?\s*[żz]e jeste[śs] cz[łl]owiekiem/i,
  /checking (if the site connection is secure|your browser)/i,
  /verify you are human/i,
  /please verify you are a human/i,
  /just a moment\.\.\./i,
];

export function isBlockingChallengeText(visibleText: string): boolean {
  const trimmed = visibleText.trim();
  if (trimmed.length > 1500) return false;
  return CHALLENGE_TEXT_PATTERNS.some((rx) => rx.test(trimmed));
}

const StepActionSchema = z.object({
  action: z.enum([
    'click',
    'fill',
    'fill_batch',
    'select',
    'wait',
    'ready_for_handoff',
    'handoff_blocker',
  ]),
  cid: z.string().nullable().default(null),
  value: z.string().nullable().default(null),
  fields: z
    .array(
      z.object({
        cid: z.string(),
        value: z.string(),
      })
    )
    .default([]),
  reason: z.string(),
  variantNote: z.string().nullable().default(null),
  detectedTotal: z.string().nullable().default(null),
  detectedShipping: z.string().nullable().default(null),
});

export function normalizeSpecNumber(raw: string): string {
  const normalized = raw.trim().replace(',', '.');
  const match = normalized.match(/^([+-]?)(\d+(?:\.\d+)?)$/);
  if (!match) return normalized;
  const sign = match[1] || '';
  const num = Number(match[2]);
  if (!Number.isFinite(num)) return normalized;
  return `${sign}${num.toFixed(2)}`;
}

export function extractRequiredPowerSpecs(contextText: string): string[] {
  if (!contextText.trim()) return [];
  const found = new Set<string>();
  const signedRx = /(?:^|[\s(,;:])([+-]\d+(?:[.,]\d{1,2}))(?=$|[\s),;:/])/g;
  for (const m of contextText.matchAll(signedRx)) {
    found.add(normalizeSpecNumber(m[1]));
  }
  const labeledRx =
    /(?:moc|pwr|dpt|dioptri\w*|si[łl]a)\s*[:=]?\s*([+-]?\d+(?:[.,]\d{1,2}))/gi;
  for (const m of contextText.matchAll(labeledRx)) {
    found.add(normalizeSpecNumber(m[1]));
  }
  return Array.from(found);
}

export function buildTaskVariantContext(
  task: TaskDetail,
  artifactId?: string | null,
  explicitVariantHint?: string
): string {
  const parts: string[] = [];
  if (explicitVariantHint?.trim()) {
    parts.push(`Wskazówka wariantu: ${explicitVariantHint.trim()}`);
  }
  if (task.title?.trim()) {
    parts.push(`Tytuł zadania: ${task.title.trim()}`);
  }
  if (task.userPrompt?.trim()) {
    parts.push(`Polecenie użytkownika: ${task.userPrompt.trim().slice(0, 300)}`);
  }
  if (task.aiSummary?.trim()) {
    parts.push(`Rozpoznane parametry produktu: ${task.aiSummary.trim().slice(0, 400)}`);
  }
  if (artifactId) {
    const art = task.artifacts.find((a) => a.id === artifactId);
    if (art) {
      parts.push(
        `Wybrany artefakt: ${art.title.trim()} ${art.content ? `— ${art.content.trim().slice(0, 220)}` : ''}`.trim()
      );
    }
  }
  const userMsgs = task.messages
    .filter((m) => m.author === 'user' && m.content.trim())
    .slice(-2)
    .map((m) => m.content.trim().slice(0, 180));
  if (userMsgs.length > 0) {
    parts.push(`Dodatkowe uwagi w wątku: ${userMsgs.join(' | ')}`);
  }
  return parts.join('\n').slice(0, 1200);
}

export function findVariantMismatchInText(
  expectedPowers: string[],
  cartSummaryText: string
): string | null {
  if (expectedPowers.length === 0 || !cartSummaryText.trim()) return null;
  const normalizedSummary = cartSummaryText.replace(/,/g, '.');
  const anyExpectedFound = expectedPowers.some((exp) => {
    const shortExp = exp.replace(/0$/, '');
    return (
      normalizedSummary.includes(exp) ||
      (shortExp !== exp && normalizedSummary.includes(shortExp))
    );
  });
  if (anyExpectedFound) return null;

  const observedPowers = extractRequiredPowerSpecs(normalizedSummary);
  if (observedPowers.length === 0) return null;
  return `Oczekiwano wariantu ${expectedPowers.join(' / ')}, a w koszyku widoczny jest ${observedPowers.join(' / ')}`;
}

interface DomElementSnapshot {
  cid: string;
  tag: string;
  type: string;
  text: string;
  label: string;
  placeholder: string;
  name: string;
  filled?: boolean;
  checked?: boolean;
  inModal?: boolean;
  selectedOption?: string;
  options?: string[];
}

function broadcastTask(taskId: string): void {
  const detail = getTaskDetail(taskId);
  if (detail) {
    eventBus.broadcast('task:updated', detail.id, detail);
  }
}

export async function prepareCheckoutSession(params: {
  taskId: string;
  artifactId?: string | null;
  productUrl: string;
  variantHint?: string;
}): Promise<CheckoutSession> {
  if (!config.CHECKOUT_ENABLED) {
    throw new Error('Funkcja Assisted Checkout jest wyłączona (CHECKOUT_ENABLED=false).');
  }

  const task = getTaskDetail(params.taskId);
  if (!task) {
    throw new Error('Zadanie nie istnieje.');
  }

  const cleanProductUrl = sanitizeUrlPathSlashes(params.productUrl);
  const parsedUrl = await assertSafePublicUrl(cleanProductUrl);
  const resolvedArtifactId =
    params.artifactId ??
    task.artifacts.find(
      (a) => a.url && sanitizeUrlPathSlashes(a.url) === parsedUrl.toString()
    )?.id ??
    null;

  const profile = await loadCheckoutProfile();
  if (!profile || !profile.fullName.trim() || !profile.email.trim() || !profile.phone.trim()) {
    throw new Error(
      'Najpierw uzupełnij „Dane dostawy” w nagłówku tablicy (imię, e-mail, telefon, adres).'
    );
  }

  const taskContext = buildTaskVariantContext(
    task,
    resolvedArtifactId,
    params.variantHint
  );
  const expectedSpecs = extractRequiredPowerSpecs(taskContext);
  const initialVariantNote =
    params.variantHint?.trim().slice(0, 140) ||
    (expectedSpecs.length > 0 ? expectedSpecs.join(', ') : null);

  ensureDataDirs();
  const sessionId = crypto.randomUUID();
  const session = createCheckoutSession({
    id: sessionId,
    taskId: params.taskId,
    artifactId: resolvedArtifactId,
    shopDomain: parsedUrl.hostname,
    productUrl: parsedUrl.toString(),
    variantNote: initialVariantNote,
    status: 'PREPARING',
    message: 'Uruchamiam przeglądarkę i otwieram stronę produktu...',
  });
  broadcastTask(params.taskId);

  // Run browser automation in background so HTTP / Discord ack stays immediate
  void executeCheckoutLoop(session, profile, taskContext, expectedSpecs).catch(
    (err) => {
      log.error('CheckoutAgent', `Nieoczekiwany błąd sesji ${session.id}`, err);
    }
  );

  return session;
}

async function executeCheckoutLoop(
  initialSession: CheckoutSession,
  profile: CheckoutProfile,
  taskContext: string,
  expectedPowers: string[]
): Promise<void> {
  const ai = getGenAI();
  if (!ai) {
    const failed = updateCheckoutSession(initialSession.id, {
      status: 'FAILED',
      message: 'Brak klucza GEMINI_API_KEY — nie można uruchomić agenta zakupowego.',
    });
    broadcastTask(initialSession.taskId);
    if (failed) {
      const task = getTaskDetail(initialSession.taskId);
      if (task) await postCheckoutSummaryToDiscordThread({ task, session: failed });
    }
    return;
  }

  const browser = await acquirePlaywrightBrowser();
  if (!browser) {
    const failed = updateCheckoutSession(initialSession.id, {
      status: 'HANDOFF_MANUAL',
      checkoutUrl: initialSession.productUrl,
      message: 'Nie udało się uruchomić Chromium — otwórz link ręcznie.',
    });
    broadcastTask(initialSession.taskId);
    if (failed) {
      const task = getTaskDetail(initialSession.taskId);
      if (task) await postCheckoutSummaryToDiscordThread({ task, session: failed });
    }
    return;
  }

  let context: Awaited<ReturnType<typeof browser.newContext>> | null = null;
  try {
    context = await browser.newContext({
      locale: 'pl-PL',
      timezoneId: 'Europe/Warsaw',
      viewport: { width: 1366, height: 900 },
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    });

    const screenshotFilename = `checkout_${initialSession.id.slice(0, 8)}.png`;
    const screenshotPath = path.join(config.uploadsDir, screenshotFilename);
    const storageStatePath = path.join(
      config.checkoutSessionsDir,
      `${initialSession.id}.json`
    );

    let finalStatus: CheckoutSession['status'] = 'READY_FOR_HANDOFF';
    let finalMessage =
      'Koszyk i formularz dostawy przygotowane — przejmij sesję i dokończ płatność ręcznie.';
    let detectedTotal: string | null = null;
    let detectedShipping: string | null = null;
    let variantNote: string | null = initialSession.variantNote ?? null;
    let currentUrl = initialSession.productUrl;

    const page = await context.newPage();
    await page.goto(initialSession.productUrl, {
      waitUntil: 'domcontentloaded',
      timeout: 22_000,
    });

    const stepHistory: string[] = [];
    const MAX_STEPS = 18;
    let lastSnapshotElements: DomElementSnapshot[] = [];

    for (let step = 1; step <= MAX_STEPS; step++) {
      await page.waitForTimeout(1000);
      currentUrl = page.url() || currentUrl;

      const snapshot = await page.evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          if (
            style.visibility === 'hidden' ||
            style.display === 'none' ||
            Number(style.opacity || '1') <= 0.05
          ) {
            return false;
          }
          // Skip elements occluded by an open modal/backdrop/overlay inside the viewport
          const cx = rect.left + rect.width / 2;
          const cy = rect.top + rect.height / 2;
          if (
            cx >= 0 &&
            cy >= 0 &&
            cx <= window.innerWidth &&
            cy <= window.innerHeight
          ) {
            const top = document.elementFromPoint(cx, cy);
            if (
              top &&
              top.tagName !== 'LABEL' &&
              !(el === top || el.contains(top) || top.contains(el))
            ) {
              const inModalOrOverlay = Boolean(
                top.closest(
                  '[role="dialog"], [aria-modal="true"], .modal, [class*="modal"], [class*="popup"], [class*="overlay"], [class*="backdrop"], [id*="cmpbox"]'
                )
              );
              if (inModalOrOverlay) {
                return false;
              }
            }
          }
          return true;
        };

        // Detect ONLY visibly rendered, blocking CAPTCHA widgets (ignore invisible reCAPTCHA v3 badges & hidden iframes)
        const captchaCandidates = Array.from(
          document.querySelectorAll(
            'iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com"], iframe[src*="challenges.cloudflare.com"], .cf-turnstile, .h-captcha'
          )
        );
        const hasVisibleCaptchaWidget = captchaCandidates.some((el) => {
          if (el.closest('.grecaptcha-badge')) return false;
          if (!isVisible(el)) return false;
          const rect = el.getBoundingClientRect();
          return rect.width >= 40 && rect.height >= 40;
        });

        const isCheckoutStage =
          /koszyk|cart|checkout|zamowien|kasa|szczegoly|dostaw|platnosc/i.test(
            window.location.href
          );

        const rawEls = Array.from(
          document.querySelectorAll(
            'button, a[href], input, select, textarea, [role="button"], label[for]'
          )
        ).filter((el) => {
          if (!isVisible(el)) return false;
          const tag = el.tagName.toLowerCase();
          if (tag === 'label') {
            const forId = el.getAttribute('for');
            if (!forId) return false;
            const target = document.getElementById(forId) as HTMLInputElement | null;
            if (!target) return false;
            const tType = (target.type || '').toLowerCase();
            // Keep label[for] only for radio/checkbox options or when the underlying input is hidden
            if (tType !== 'radio' && tType !== 'checkbox' && isVisible(target)) {
              return false;
            }
          }
          // Skip category/header/footer nav links cluttering checkout prompts while keeping cart/checkout links
          if (tag === 'a') {
            const href = el.getAttribute('href') || '';
            const txt = (el.textContent || '').trim();
            const isNavShell = Boolean(el.closest('header nav, footer, .footer, #footer, [class*="menu-main"]'));
            if (
              isNavShell &&
              !/koszyk|cart|checkout|kasa|zamow|login|guest|go[sś][cć]|dalej|zap[lł]a/i.test(
                `${href} ${txt}`
              )
            ) {
              return false;
            }
          }
          return true;
        });

        document
          .querySelectorAll('[data-consiler-id]')
          .forEach((n) => n.removeAttribute('data-consiler-id'));

        const elements: DomElementSnapshot[] = [];
        rawEls.slice(0, 75).forEach((el, idx) => {
          const cid = `c${idx}`;
          el.setAttribute('data-consiler-id', cid);
          const tag = el.tagName.toLowerCase();
          const htmlEl = el as HTMLElement;
          const inputEl = el as HTMLInputElement;
          const selectEl = el as HTMLSelectElement;
          const inputType = (inputEl.type || '').toLowerCase();

          let labelText = '';
          if (inputEl.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(inputEl.id)}"]`);
            if (lbl) labelText = (lbl.textContent || '').trim();
          }
          if (!labelText && el.closest('label')) {
            labelText = (el.closest('label')?.textContent || '').trim();
          }

          const inModal = Boolean(
            el.closest(
              '[role="dialog"], [aria-modal="true"], .modal, .cmpbox, [id*="cmpbox"], [class*="modal"], [class*="popup"]'
            )
          );

          const rawVal = (inputEl.value || '').trim();
          const isEmailJunkPlaceholder = rawVal === '@';

          const entry: DomElementSnapshot = {
            cid,
            tag,
            type: inputType,
            text: (htmlEl.innerText || el.textContent || (inputType === 'submit' || inputType === 'button' ? rawVal : '') || '')
              .replace(/\s+/g, ' ')
              .trim()
              .slice(0, 90),
            label: labelText.replace(/\s+/g, ' ').slice(0, 80),
            placeholder: (inputEl.placeholder || (isEmailJunkPlaceholder ? 'prefilled:@' : '')).slice(0, 60),
            name: (inputEl.name || el.id || '').slice(0, 60),
          };

          if (inModal) {
            entry.inModal = true;
          }

          if (tag === 'select') {
            const selText = selectEl.selectedOptions[0]?.text?.trim() || '';
            entry.selectedOption = selText;
            entry.filled = Boolean(
              selectEl.value &&
                selectEl.value !== '-1' &&
                !/^wybierz/i.test(selText)
            );
            entry.options = Array.from(selectEl.options)
              .slice(0, isCheckoutStage ? 18 : 150)
              .map((o) => o.text.trim())
              .filter(Boolean);
          } else if (tag === 'textarea' || (tag === 'input' && !['submit', 'button', 'hidden', 'reset', 'image'].includes(inputType))) {
            if (inputType === 'checkbox' || inputType === 'radio') {
              entry.checked = inputEl.checked;
              entry.filled = inputEl.checked;
            } else {
              entry.filled = Boolean(rawVal && !isEmailJunkPlaceholder);
            }
          }

          elements.push(entry);
        });

        const visibleText = (document.body?.innerText || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 2600);

        return {
          url: window.location.href,
          title: document.title,
          hasCaptcha: hasVisibleCaptchaWidget,
          visibleText,
          elements,
        };
      });
      lastSnapshotElements = snapshot.elements;

      if (snapshot.hasCaptcha || isBlockingChallengeText(snapshot.visibleText)) {
        finalStatus = 'HANDOFF_MANUAL';
        finalMessage =
          'Sklep wyświetlił zabezpieczenie CAPTCHA / weryfikację anty-botową — przekazuję sterowanie do ręcznego dokończenia.';
        log.info('CheckoutAgent', `CAPTCHA/anty-bot wykryty w kroku ${step}`, {
          sessionId: initialSession.id,
          widget: snapshot.hasCaptcha,
        });
        break;
      }

      // Deterministic local shipping-form auto-fill (progressive-disclosure aware, zero PII sent to LLM)
      if (
        /koszyk|cart|checkout|zamowien|kasa|szczegoly|dostaw|platnosc/i.test(
          snapshot.url
        )
      ) {
        const autoFilled = await autoFillVisibleShippingFields(page, profile);
        if (autoFilled.length > 0) {
          log.info('CheckoutAgent', `Krok ${step} auto-fill dostawy OK`, {
            fields: autoFilled,
          });
          stepHistory.push(
            `Krok ${step}: auto-fill formularza dostawy [${autoFilled.join(', ')}]`
          );
          continue;
        }
      }

      const promptText = `CEL: Przygotować zakup produktu w sklepie (Faza 1.5: wybrać dokładny wariant zgodny z zadaniem, dodać do koszyka, przejść do kasy jako gość, wypełnić dane dostawy i zatrzymać się PRZED płatnością).
WYMAGANE SPECYFIKACJE Z ZADANIA (KRYTYCZNE — MUSISZ DOBRAĆ DOKŁADNY WARIANT!):
${taskContext || '(brak dodatkowych uwag)'}
${expectedPowers.length > 0 ? `WYMAGANE WARTOŚCI MOCY / PARAMETRÓW: ${expectedPowers.join(', ')}` : ''}
KROK: ${step} / ${MAX_STEPS}
HISTORIA AKCJI:
${stepHistory.join('\n') || '(początek)'}

DOSTĘPNE PLACEHOLDERY DANYCH DOSTAWY (używaj ich w "value" przy akcji "fill" lub "fill_batch"):
- {{FULL_NAME}}, {{FIRST_NAME}}, {{LAST_NAME}}
- {{EMAIL}}, {{PHONE}}
- {{STREET}}, {{POSTAL_CODE}}, {{CITY}}
- {{LOCKER}} (preferowany paczkomat, jeśli pole tego dotyczy)
- {{NOTES}} (uwagi do zamówienia)

AKTUALNY ADRES: ${snapshot.url}
TYTUŁ STRONY: ${snapshot.title}
WIDOCZNY TEKST STRONY (skrót):
${snapshot.visibleText}

INTERAKTYWNE ELEMENTY DOM (JSON):
${JSON.stringify(snapshot.elements)}`;

      let aiRes;
      let lastAiErr: unknown = null;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          aiRes = await generateWithTimeout(
            `checkout-${initialSession.id.slice(0, 8)}-s${step}${attempt > 1 ? `-r${attempt}` : ''}`,
            {
              model: config.GEMINI_TRIAGE_MODEL,
              contents: [{ role: 'user', parts: [{ text: promptText }] }],
              config: {
                systemInstruction: `Jesteś precyzyjnym agentem przygotowania koszyka i formularza dostawy (Playwright DOM).
ZASADY BEZPIECZEŃSTWA I PRACY:
1. Najpierw zamknij baner cookies ("Akceptuj", "Zgadzam się") lub wyskakujące okno modalne (gdzie element ma "inModal": true), jeśli blokuje stronę.
   UWAGA NA NEWSLETTER INLINE: NIE klikaj przycisków rezygnacji z newslettera typu "Nie, dziękuję. Nie chcę oszczędzić pieniędzy" (name="cancel"), jeśli NIE mają "inModal": true — są one osobnym formularzem <form> na dole strony, którego kliknięcie przeładowuje stronę i KASUJE wypełnione pola dostawy!
2. WARIANT PRODUKTU (OBOWIĄZKOWE): Jeśli zadanie podaje moc/parametr (np. "-1.50", "BC 8.6", "rozmiar M"), MUSISZ na liście <select> odnaleźć i wybrać DOKŁADNIE ten parametr (akcja "select" przed kliknięciem "Dodaj do koszyka"). NIGDY nie zostawiaj domyślnej lub innej wartości (np. "-6.00" zamiast "-1.50"). W polu "variantNote" wpisuj aktualnie dobrany wariant (np. "-1.50, BC 8.60, DIA 14.20").
3. Po dodaniu właściwego wariantu do koszyka przejdź do koszyka / kasy ("Pokaż mój koszyk", "Przejdź do kasy", "Przejdź do zamówienia").
4. Wybierz opcję GOŚCIA ("Kup bez rejestracji", "Kontynuuj jako gość", "Zamów bez zakładania konta"), jeśli sklep pyta o logowanie. Jeśli logowanie jest obowiązkowe bez gościa — zwróć "handoff_blocker".
5. FORMULARZ DOSTAWY:
   - Jeśli na stronie najpierw widać samo pole e-mail (nawet jeśli ma domyślne "@", tj. "filled": false), najpierw wpisz {{EMAIL}} akcją "fill" — sklep często dopiero po e-mailu odsłania imię, nazwisko, telefon i adres!
   - Gdy widoczne są pola imienia, nazwiska, telefonu i adresu z "filled": false — użyj akcji **"fill_batch"** (ZAWSZE z niepustą tablicą \`fields: [{"cid":"...","value":"{{...}}"}]\`), aby w JEDNYM kroku wypełnić wszystkie puste pola (<input> / <textarea>, NIE klikaj <label>) używając WYŁĄCZNIE placeholderów ({{EMAIL}}, {{PHONE}}, {{FIRST_NAME}}, {{LAST_NAME}}, {{FULL_NAME}}, {{STREET}}, {{POSTAL_CODE}}, {{CITY}}, {{LOCKER}}). Zaznacz wymagane checkboxy regulaminu, ale NIE klikaj przycisków płatności.
   - NIE kończ akcją "ready_for_handoff", dopóki pola adresu dostawy i e-mail NIE mają "filled": true!
6. **ZAKAZ KLIKANIA PŁATNOŚCI:** Gdy wariant w koszyku się zgadza, formularz dostawy ma wypełnione pola ("filled": true) oraz widoczny jest przycisk finalizacji ("Kupuję i płacę", "Zakończ zamówienie i zapłać", "Zapłać", "Place order") — ZAWSZE wybierz akcję "ready_for_handoff"!
7. Zawsze podawaj w "detectedTotal" i "detectedShipping" aktualnie widoczną kwotę końcową i koszt wysyłki (np. "178,94 zł", "13,95 zł").`,
                responseMimeType: 'application/json',
                responseSchema: {
                  type: Type.OBJECT,
                  properties: {
                    action: {
                      type: Type.STRING,
                      enum: [
                        'click',
                        'fill',
                        'fill_batch',
                        'select',
                        'wait',
                        'ready_for_handoff',
                        'handoff_blocker',
                      ],
                    },
                    cid: { type: Type.STRING, nullable: true },
                    value: { type: Type.STRING, nullable: true },
                    fields: {
                      type: Type.ARRAY,
                      items: {
                        type: Type.OBJECT,
                        properties: {
                          cid: { type: Type.STRING },
                          value: { type: Type.STRING },
                        },
                        required: ['cid', 'value'],
                      },
                    },
                    reason: { type: Type.STRING },
                    variantNote: { type: Type.STRING, nullable: true },
                    detectedTotal: { type: Type.STRING, nullable: true },
                    detectedShipping: { type: Type.STRING, nullable: true },
                  },
                  required: ['action', 'reason'],
                },
              },
            },
            28_000
          );
          break;
        } catch (err) {
          lastAiErr = err;
          log.warn('CheckoutAgent', `Próba ${attempt} kroku ${step} nie powiodła się`, {
            err: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (!aiRes) {
        finalStatus = 'HANDOFF_MANUAL';
        finalMessage = `Przekroczono czas odpowiedzi AI w kroku ${step} — zapisano aktualny stan sesji do ręcznego dokończenia (${lastAiErr instanceof Error ? lastAiErr.message : 'timeout'}).`;
        break;
      }

      const decision = StepActionSchema.parse(JSON.parse(aiRes.text ?? '{}'));
      if (decision.variantNote) variantNote = decision.variantNote.trim().slice(0, 140);
      if (decision.detectedTotal) detectedTotal = decision.detectedTotal;
      if (decision.detectedShipping) detectedShipping = decision.detectedShipping;

      log.info('CheckoutAgent', `Krok ${step}: ${decision.action}`, {
        cid: decision.cid,
        fieldsCount: decision.fields.length || undefined,
        reason: decision.reason,
        total: detectedTotal,
      });

      if (decision.action === 'ready_for_handoff') {
        const liveCheck = await inspectCheckoutFormAndCart(page);
        if (
          step < MAX_STEPS &&
          liveCheck.hasShippingForm &&
          liveCheck.filledShippingCount === 0
        ) {
          const emptyNames = liveCheck.unfilledShippingNames.slice(0, 6).join(', ');
          log.warn('CheckoutAgent', `Odrzucono przedwczesne ready_for_handoff w kroku ${step}`, {
            emptyNames,
          });
          stepHistory.push(
            `Krok ${step}: ODMOWA ready_for_handoff — formularz dostawy nadal ma puste pola (${emptyNames || 'email/adres'}). Najpierw wypełnij je przez fill / fill_batch!`
          );
          continue;
        }
        finalStatus = 'READY_FOR_HANDOFF';
        finalMessage = decision.reason;
        break;
      }

      if (decision.action === 'handoff_blocker') {
        finalStatus = 'HANDOFF_MANUAL';
        finalMessage = decision.reason;
        break;
      }

      if (decision.action === 'wait') {
        stepHistory.push(`Krok ${step}: wait (${decision.reason})`);
        await page.waitForTimeout(1500);
        continue;
      }

      if (decision.action === 'fill_batch') {
        if (decision.fields.length === 0) {
          log.warn('CheckoutAgent', `Krok ${step}: fill_batch z pustą tablicą fields`);
          stepHistory.push(
            `Krok ${step}: BŁĄD fill_batch — tablica "fields" jest pusta! Podaj konkretną listę [{"cid":"...","value":"{{PLACEHOLDER}}"}] albo użyj akcji "fill".`
          );
          continue;
        }
        const results: string[] = [];
        for (const f of decision.fields.slice(0, 15)) {
          const fieldLoc = page.locator(`[data-consiler-id="${f.cid}"]`).first();
          if ((await fieldLoc.count()) === 0) {
            results.push(`${f.cid}:brak`);
            continue;
          }
          const resolved = resolveProfilePlaceholder(f.value, profile);
          try {
            await fillInputRobust(fieldLoc, resolved);
            results.push(`${f.cid}:${f.value}`);
          } catch (batchErr) {
            const msg = batchErr instanceof Error ? batchErr.message.split('\n')[0] : 'err';
            results.push(`${f.cid}:błąd(${msg.slice(0, 35)})`);
          }
        }
        await page.waitForTimeout(450);
        log.info('CheckoutAgent', `Krok ${step} fill_batch wynik`, { results });
        stepHistory.push(
          `Krok ${step}: fill_batch [${results.join(', ')}] (${decision.reason})`
        );
        continue;
      }

      if (!decision.cid) {
        stepHistory.push(`Krok ${step}: brak cid (${decision.reason})`);
        continue;
      }

      const locator = page.locator(`[data-consiler-id="${decision.cid}"]`).first();
      const count = await locator.count();
      if (count === 0) {
        stepHistory.push(`Krok ${step}: element ${decision.cid} zniknął`);
        continue;
      }

      if (decision.action === 'click') {
        const snapMeta = lastSnapshotElements.find((e) => e.cid === decision.cid);
        const liveText = await locator
          .evaluate((el) => {
            const input = el as HTMLInputElement;
            return `${el.textContent || ''} ${input.value || ''} ${el.getAttribute('aria-label') || ''}`.trim();
          })
          .catch(() => '');

        if (isForbiddenPaymentButton(liveText)) {
          log.warn(
            'CheckoutAgent',
            `Twarda blokada kliknięcia przycisku płatności: "${liveText}"`
          );
          finalStatus = 'READY_FOR_HANDOFF';
          finalMessage = `Zatrzymano bezpiecznie przed przyciskiem „${liveText}” — gotowe do przejęcia i ręcznej płatności.`;
          break;
        }

        // Guard against clicking an inline newsletter opt-out submit button (reloads page & wipes form)
        if (
          !snapMeta?.inModal &&
          (snapMeta?.name === 'cancel' ||
            /nie\s*chc[eę]\s*oszcz[eę]dzi|rezygnuj[eę]\s*z\s*newsletter/i.test(liveText))
        ) {
          log.info('CheckoutAgent', `Pominięto inline cancel/newsletter (${decision.cid})`);
          stepHistory.push(
            `Krok ${step}: POMINIĘTO click ${decision.cid} (przycisk inline newslettera mógłby przeładować stronę i skasować dane dostawy).`
          );
          continue;
        }

        // Guard against adding product to cart with wrong variant selected in <select>
        if (
          expectedPowers.length > 0 &&
          /dodaj\s*do\s*koszyka|do\s*koszyka|add\s*to\s*cart/i.test(liveText)
        ) {
          const mismatch = lastSnapshotElements.find((el) => {
            if (el.tag !== 'select' || !el.options || el.options.length <= 1) return false;
            const matchingOpt = el.options.find((opt) =>
              expectedPowers.some((p) => opt.replace(',', '.').includes(p))
            );
            if (!matchingOpt) return false;
            const cur = (el.selectedOption || '').replace(',', '.');
            return !expectedPowers.some((p) => cur.includes(p));
          });
          if (mismatch) {
            log.warn('CheckoutAgent', 'Blokada dodania do koszyka — zły wariant w <select>', {
              cid: mismatch.cid,
              selected: mismatch.selectedOption,
              expected: expectedPowers,
            });
            stepHistory.push(
              `Krok ${step}: BLOKADA click ${decision.cid} — w liście ${mismatch.cid} (${mismatch.name}) wybrano "${mismatch.selectedOption || '?'}" zamiast wymaganego wariantu (${expectedPowers.join(', ')})! Najpierw użyj akcji 'select' na ${mismatch.cid}.`
            );
            continue;
          }
        }

        await centerElement(locator);
        try {
          await locator.click({ timeout: 5_000 });
          stepHistory.push(`Krok ${step}: click [${liveText.slice(0, 40)}] (${decision.reason})`);
        } catch (clickErr) {
          try {
            await locator.click({ force: true, timeout: 4_000 });
            stepHistory.push(`Krok ${step}: click-force [${liveText.slice(0, 40)}] (${decision.reason})`);
          } catch {
            const msg = clickErr instanceof Error ? clickErr.message.split('\n')[0] : 'click failed';
            stepHistory.push(`Krok ${step}: NIEUDANY click ${decision.cid} [${liveText.slice(0, 30)}]: ${msg.slice(0, 80)}`);
          }
        }
      } else if (decision.action === 'fill') {
        const resolved = resolveProfilePlaceholder(
          decision.value ?? '',
          profile
        );
        try {
          await fillInputRobust(locator, resolved);
          await page.waitForTimeout(450);
          log.info('CheckoutAgent', `Krok ${step} fill OK`, {
            cid: decision.cid,
            placeholder: decision.value,
          });
          stepHistory.push(
            `Krok ${step}: fill ${decision.cid} <- ${decision.value ?? ''} (${decision.reason})`
          );
        } catch (fillErr) {
          const msg = fillErr instanceof Error ? fillErr.message.split('\n')[0] : 'fill failed';
          log.warn('CheckoutAgent', `Krok ${step} fill FAILED`, { cid: decision.cid, msg });
          stepHistory.push(`Krok ${step}: NIEUDANY fill ${decision.cid}: ${msg.slice(0, 80)}`);
        }
      } else if (decision.action === 'select') {
        const val = resolveProfilePlaceholder(decision.value ?? '', profile);
        await centerElement(locator);
        try {
          const picked = await selectOptionSmart(locator, val);
          log.info('CheckoutAgent', `Krok ${step} select OK`, {
            cid: decision.cid,
            requested: val,
            picked,
          });
          stepHistory.push(
            `Krok ${step}: select ${decision.cid} -> "${picked || val}" (${decision.reason})`
          );
        } catch (selErr) {
          const msg = selErr instanceof Error ? selErr.message.split('\n')[0] : 'select failed';
          log.warn('CheckoutAgent', `Krok ${step} select FAILED`, { cid: decision.cid, val, msg });
          stepHistory.push(`Krok ${step}: NIEUDANY select ${decision.cid}: ${msg.slice(0, 80)}`);
        }
      }
    }

    // Pre-handoff live verification & state capture
    await page.waitForTimeout(300);
    const verification = await inspectCheckoutFormAndCart(page);
    const variantMismatch = findVariantMismatchInText(
      expectedPowers,
      verification.cartSummaryText
    );
    if (variantMismatch && finalStatus === 'READY_FOR_HANDOFF') {
      finalStatus = 'HANDOFF_MANUAL';
      finalMessage = `⚠️ Wykryto rozbieżność wariantu przed przekazaniem: ${variantMismatch}. Zweryfikuj koszyk przed płatnością.`;
    } else if (
      finalStatus === 'READY_FOR_HANDOFF' &&
      verification.hasShippingForm &&
      verification.filledShippingCount === 0
    ) {
      finalStatus = 'HANDOFF_MANUAL';
      finalMessage = `⚠️ Formularz dostawy nie został w pełni zapisany (wypełnionych pól: 0). Otwórz sesję i uzupełnij dane ręcznie.`;
    }

    if (!variantNote && expectedPowers.length > 0 && !variantMismatch) {
      variantNote = expectedPowers.join(', ');
    }

    log.info('CheckoutAgent', 'Weryfikacja przed przekazaniem sesji', {
      sessionId: initialSession.id,
      status: finalStatus,
      filledShippingCount: verification.filledShippingCount,
      unfilledShippingCount: verification.unfilledShippingNames.length,
      variantMismatch: variantMismatch ?? 'none',
      total: detectedTotal,
    });

    // Enforce max order amount safety check
    const numericTotal = parsePlnAmount(detectedTotal);
    if (numericTotal !== null && numericTotal > config.CHECKOUT_MAX_AMOUNT_PLN) {
      finalStatus = 'HANDOFF_MANUAL';
      finalMessage = `⚠️ Wykryta kwota (${detectedTotal}) przekracza ustawiony limit bezpieczeństwa ${config.CHECKOUT_MAX_AMOUNT_PLN} zł. Sprawdź koszyk ręcznie.`;
    }

    currentUrl = page.url() || currentUrl;
    await page
      .screenshot({ path: screenshotPath, fullPage: false })
      .catch(() => undefined);
    await context.storageState({ path: storageStatePath }).catch(() => undefined);

    // Save encrypted sessionStorage + non-sensitive form field snapshot for faithful handoff restoration
    const handoffPayload = await captureHandoffPayload(page);
    if (handoffPayload) {
      await saveEncryptedJson(
        handoffPayload,
        handoffSidecarPath(storageStatePath)
      ).catch((err) => {
        log.warn('CheckoutAgent', 'Nie udało się zapisać handoff sidecar', {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }

    const updated = updateCheckoutSession(initialSession.id, {
      status: finalStatus,
      checkoutUrl: currentUrl,
      variantNote,
      detectedTotal,
      detectedShipping,
      screenshotFilename,
      storageStatePath,
      message: finalMessage,
    });

    broadcastTask(initialSession.taskId);
    if (updated) {
      const task = getTaskDetail(initialSession.taskId);
      if (task) {
        await postCheckoutSummaryToDiscordThread({ task, session: updated });
      }
    }
  } catch (err) {
    log.error('CheckoutAgent', `Błąd wykonania sesji ${initialSession.id}`, err);
    const failed = updateCheckoutSession(initialSession.id, {
      status: 'FAILED',
      checkoutUrl: initialSession.productUrl,
      message: `Nie udało się przygotować koszyka: ${err instanceof Error ? err.message : 'Błąd przeglądarki'}`,
    });
    broadcastTask(initialSession.taskId);
    if (failed) {
      const task = getTaskDetail(initialSession.taskId);
      if (task) {
        await postCheckoutSummaryToDiscordThread({ task, session: failed });
      }
    }
  } finally {
    if (context) {
      await context.close().catch(() => undefined);
    }
    releasePlaywrightBrowser();
  }
}

async function centerElement(locator: Locator): Promise<void> {
  await locator
    .evaluate((el) => {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
    })
    .catch(() => undefined);
}

async function autoFillVisibleShippingFields(
  page: Page,
  profile: CheckoutProfile
): Promise<string[]> {
  const filledKeys: string[] = [];

  for (let pass = 1; pass <= 2; pass++) {
    const candidates = await page
      .evaluate(() => {
        const isVisible = (el: Element): boolean => {
          const rect = el.getBoundingClientRect();
          if (rect.width <= 0 || rect.height <= 0) return false;
          const style = window.getComputedStyle(el);
          return style.visibility !== 'hidden' && style.display !== 'none';
        };
        document
          .querySelectorAll('[data-consiler-autofill]')
          .forEach((n) => n.removeAttribute('data-consiler-autofill'));

        const out: Array<{
          autoId: string;
          name: string;
          id: string;
          autocomplete: string;
          label: string;
          placeholder: string;
          type: string;
        }> = [];
        let idx = 0;
        const passToken = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
        for (const el of Array.from(document.querySelectorAll('input, textarea'))) {
          if (!isVisible(el)) continue;
          const inp = el as HTMLInputElement;
          const form = inp.form;
          if (form && form.querySelector('input[name="cancel"]')) continue;
          const val = (inp.value || '').trim();
          if (val && val !== '@') continue;

          let label = '';
          if (inp.id) {
            const lbl = document.querySelector(`label[for="${CSS.escape(inp.id)}"]`);
            if (lbl) label = (lbl.textContent || '').trim();
          }
          if (!label && inp.closest('label')) {
            label = (inp.closest('label')?.textContent || '').trim();
          }
          const autoId = `af-${passToken}-${idx++}`;
          inp.setAttribute('data-consiler-autofill', autoId);
          out.push({
            autoId,
            name: inp.name || '',
            id: inp.id || '',
            autocomplete: inp.getAttribute('autocomplete') || '',
            label,
            placeholder: inp.placeholder || '',
            type: (inp.type || 'text').toLowerCase(),
          });
        }
        return out;
      })
      .catch(() => []);

    let filledInPass = 0;
    for (const c of candidates) {
      const matched = matchShippingProfileField(c, profile);
      if (!matched) continue;
      const loc = page.locator(`[data-consiler-autofill="${c.autoId}"]`).first();
      if ((await loc.count()) === 0) continue;
      try {
        await fillInputRobust(loc, matched.value);
        filledKeys.push(`${matched.key}(${c.name || c.id || c.autoId})`);
        filledInPass += 1;
      } catch {
        // Leave unmatched/failing field for AI/manual fallback
      }
    }

    if (filledInPass === 0) break;
    // Wait for progressive-disclosure forms (e.g. email-first checkout) to reveal next fields before pass 2
    await page.waitForTimeout(1_400);
  }

  return filledKeys;
}

async function fillInputRobust(locator: Locator, value: string): Promise<void> {
  await centerElement(locator);
  try {
    await locator.fill(value, { timeout: 3_000 });
    await locator.blur().catch(() => undefined);
    return;
  } catch {
    // Retry once with force:true (handles transient CSS/label overlays)
  }
  await locator.fill(value, { force: true, timeout: 2_500 });
  await locator.blur().catch(() => undefined);
}

async function selectOptionSmart(
  locator: Locator,
  rawTarget: string
): Promise<string> {
  const target = rawTarget.trim();
  const normalizedTarget = target.replace(',', '.').toLowerCase();

  try {
    await locator.selectOption({ label: target }, { timeout: 3_000 });
    return target;
  } catch {
    // Fallback: match by value OR normalized option text (handles trailing spaces, units, or comma vs dot)
  }

  const matchedValue = await locator
    .evaluate((el, norm) => {
      const sel = el as HTMLSelectElement;
      for (const opt of Array.from(sel.options)) {
        const t = opt.text.trim().replace(',', '.').toLowerCase();
        const v = opt.value.trim().replace(',', '.').toLowerCase();
        if (t === norm || v === norm || (norm.length >= 2 && t.includes(norm))) {
          return { value: opt.value, text: opt.text.trim() };
        }
      }
      return null;
    }, normalizedTarget)
    .catch(() => null);

  if (matchedValue) {
    await locator.selectOption(matchedValue.value, { timeout: 3_000 });
    return matchedValue.text;
  }

  await locator.selectOption(target, { timeout: 3_000 });
  return target;
}

async function inspectCheckoutFormAndCart(page: Page): Promise<{
  hasShippingForm: boolean;
  filledShippingCount: number;
  unfilledShippingNames: string[];
  cartSummaryText: string;
}> {
  return page
    .evaluate(() => {
      const shippingRx =
        /email|e-mail|name|surname|first|last|phone|tel|street|ulic|city|miasto|postal|kod|zip|adress|address|locker|paczkomat|imie|nazwisk/i;
      const isVisible = (el: Element): boolean => {
        const rect = el.getBoundingClientRect();
        if (rect.width <= 0 || rect.height <= 0) return false;
        const style = window.getComputedStyle(el);
        return style.visibility !== 'hidden' && style.display !== 'none';
      };

      const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(
        (el) => {
          const inp = el as HTMLInputElement;
          const type = (inp.type || 'text').toLowerCase();
          if (['submit', 'button', 'hidden', 'reset', 'image', 'password'].includes(type)) {
            return false;
          }
          if (!isVisible(el)) return false;
          // Exclude newsletter inline forms (usually named email inside doi* form or sibling cancel button)
          const form = inp.form;
          if (form && form.querySelector('input[name="cancel"]')) return false;
          const key = `${inp.name || ''} ${inp.id || ''} ${inp.placeholder || ''}`;
          return shippingRx.test(key);
        }
      ) as HTMLInputElement[];

      let filledShippingCount = 0;
      const unfilledShippingNames: string[] = [];
      for (const inp of inputs) {
        const v = (inp.value || '').trim();
        const isEmailJunk = v === '@';
        if (inp.type === 'checkbox' || inp.type === 'radio') {
          if (inp.checked) filledShippingCount += 1;
        } else if (v && !isEmailJunk) {
          filledShippingCount += 1;
        } else {
          unfilledShippingNames.push(inp.name || inp.id || inp.placeholder || 'field');
        }
      }

      // Extract visible cart/order text WITHOUT dropdown <select> options (prevents upsell dropdown noise)
      let cartSummaryText = '';
      if (document.body) {
        const clone = document.body.cloneNode(true) as HTMLElement;
        clone
          .querySelectorAll('select, [class*="upsell"], [class*="recommend"], [class*="cross-sell"]')
          .forEach((n) => n.remove());
        cartSummaryText = (clone.innerText || clone.textContent || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, 6000);
      }

      return {
        hasShippingForm: inputs.length > 0,
        filledShippingCount,
        unfilledShippingNames,
        cartSummaryText,
      };
    })
    .catch(() => ({
      hasShippingForm: false,
      filledShippingCount: 0,
      unfilledShippingNames: [],
      cartSummaryText: '',
    }));
}

async function captureHandoffPayload(
  page: Page
): Promise<CheckoutHandoffPayload | null> {
  return page
    .evaluate(() => {
      const origin = window.location.origin;
      const sessionStorageEntries: Array<[string, string]> = [];
      try {
        for (let i = 0; i < window.sessionStorage.length; i++) {
          const k = window.sessionStorage.key(i);
          if (k !== null) {
            sessionStorageEntries.push([k, window.sessionStorage.getItem(k) ?? '']);
          }
        }
      } catch {
        // Ignore sessionStorage restrictions
      }

      const sensitiveRx = /pass|cvv|cvc|card|blik|pin|otp|token|csrf|captcha/i;
      const formFields: SavedFormFieldSnapshot[] = [];

      for (const el of Array.from(document.querySelectorAll('input, select, textarea'))) {
        const tag = el.tagName.toLowerCase() as 'input' | 'select' | 'textarea';
        const inp = el as HTMLInputElement;
        const type = (inp.type || '').toLowerCase();
        if (['password', 'hidden', 'submit', 'button', 'reset', 'file', 'image'].includes(type)) {
          continue;
        }
        const form = inp.form;
        if (form && form.querySelector('input[name="cancel"]')) continue;

        const keyMeta = `${inp.name || ''} ${inp.id || ''} ${inp.autocomplete || ''}`;
        if (sensitiveRx.test(keyMeta)) continue;
        if (
          tag === 'select' &&
          !/country|kraj|city|state|region|address|adress|delivery|shipping|payment|locker|paczkomat/i.test(
            keyMeta
          )
        ) {
          continue;
        }

        const rect = el.getBoundingClientRect();
        const style = window.getComputedStyle(el);
        if (rect.width <= 0 || rect.height <= 0 || style.display === 'none') continue;

        const val = (inp.value || '').trim();
        if (type === 'checkbox' || type === 'radio') {
          if (inp.checked && (inp.name || inp.id)) {
            formFields.push({
              tag,
              name: inp.name || '',
              id: inp.id || '',
              type,
              value: val,
              checked: true,
            });
          }
        } else if (val && val !== '@' && (inp.name || inp.id)) {
          formFields.push({
            tag,
            name: inp.name || '',
            id: inp.id || '',
            type,
            value: inp.value,
          });
        }
      }

      return {
        origin,
        sessionStorage: sessionStorageEntries,
        formFields: formFields.slice(0, 40),
      };
    })
    .catch(() => null);
}

export async function launchCheckoutSessionLocal(
  sessionId: string
): Promise<CheckoutSession> {
  const session = getCheckoutSession(sessionId);
  if (!session) throw new Error('Sesja zakupu nie istnieje.');

  const targetUrl = session.checkoutUrl || session.productUrl;
  await assertSafePublicUrl(targetUrl);

  let statePath: string | null = null;
  if (session.storageStatePath) {
    const exists = await fs
      .access(session.storageStatePath)
      .then(() => true)
      .catch(() => false);
    if (exists) statePath = session.storageStatePath;
  }

  await launchVisibleCheckoutWindow(targetUrl, statePath);
  const updated =
    updateCheckoutSession(session.id, {
      status: 'LAUNCHED_LOCAL',
      message: 'Otwarto widoczne okno Chromium na komputerze do ręcznej płatności.',
    }) ?? session;
  broadcastTask(updated.taskId);
  return updated;
}

export async function finishCheckoutSession(
  sessionId: string,
  outcome: 'COMPLETED' | 'CANCELLED'
): Promise<CheckoutSession> {
  const session = getCheckoutSession(sessionId);
  if (!session) throw new Error('Sesja zakupu nie istnieje.');

  if (session.storageStatePath) {
    await fs.unlink(session.storageStatePath).catch(() => undefined);
    await fs
      .unlink(handoffSidecarPath(session.storageStatePath))
      .catch(() => undefined);
  }

  const updated =
    updateCheckoutSession(session.id, {
      status: outcome,
      storageStatePath: null,
      message:
        outcome === 'COMPLETED'
          ? 'Zamówienie oznaczone jako opłacone / zakończone.'
          : 'Sesja zakupu anulowana.',
    }) ?? session;
  broadcastTask(updated.taskId);
  return updated;
}
