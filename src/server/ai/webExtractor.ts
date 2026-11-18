import * as cheerio from 'cheerio';
import net from 'node:net';
import dns from 'node:dns/promises';
import { fetchRenderedPageWithPlaywright } from './browserVerifier.js';

const MAX_BYTES = 1_500_000;
const FETCH_TIMEOUT_MS = 10_000;
const MAX_EXTRACTED_CHARS = 8_000;
const MAX_REDIRECT_HOPS = 6;

function isPrivateIp(ip: string): boolean {
  if (net.isIPv4(ip)) {
    const parts = ip.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 0) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 100 && parts[1] >= 64 && parts[1] <= 127) return true;
    return false;
  }
  if (net.isIPv6(ip)) {
    const norm = ip.toLowerCase();
    return (
      norm === '::1' ||
      norm.startsWith('fc') ||
      norm.startsWith('fd') ||
      norm.startsWith('fe80')
    );
  }
  return true;
}

export function sanitizeUrlPathSlashes(rawUrl: string): string {
  const trimmed = rawUrl.trim();
  if (!trimmed) return trimmed;
  try {
    const u = new URL(trimmed);
    const cleanedPath = u.pathname.replace(/\/{2,}/g, '/');
    if (cleanedPath !== u.pathname) {
      u.pathname = cleanedPath;
    }
    return u.toString();
  } catch {
    return trimmed;
  }
}

export async function assertSafePublicUrl(rawUrl: string): Promise<URL> {
  const parsed = new URL(rawUrl);
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol: ${parsed.protocol}`);
  }
  const hostname = parsed.hostname;
  if (
    hostname === 'localhost' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local')
  ) {
    throw new Error('Blocked local hostname');
  }
  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) {
      throw new Error('Blocked private IP');
    }
    return parsed;
  }
  const resolved = await dns.lookup(hostname, { all: true });
  for (const entry of resolved) {
    if (isPrivateIp(entry.address)) {
      throw new Error('Blocked private resolved IP');
    }
  }
  return parsed;
}

const DEFAULT_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  Accept:
    'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
  'Accept-Language': 'pl-PL,pl;q=0.9,en-US;q=0.8,en;q=0.7',
};

async function fetchWithSafeRedirects(
  rawUrl: string,
  signal: AbortSignal
): Promise<{
  response: Response;
  finalUrl: string;
  firstTargetUrl: string;
}> {
  let currentUrl = (await assertSafePublicUrl(rawUrl)).toString();
  let firstTargetUrl = currentUrl.includes('vertexaisearch.cloud.google.com')
    ? ''
    : currentUrl;

  for (let hop = 0; hop < MAX_REDIRECT_HOPS; hop++) {
    const response = await fetch(currentUrl, {
      signal,
      redirect: 'manual',
      headers: DEFAULT_HEADERS,
    });

    if (
      response.status >= 300 &&
      response.status < 400 &&
      response.headers.get('location')
    ) {
      const location = response.headers.get('location')!;
      const nextUrl = new URL(location, currentUrl).toString();
      await response.body?.cancel().catch(() => undefined);
      currentUrl = (await assertSafePublicUrl(nextUrl)).toString();
      if (!firstTargetUrl && !currentUrl.includes('vertexaisearch.cloud.google.com')) {
        firstTargetUrl = currentUrl;
      }
      continue;
    }

    return {
      response,
      finalUrl: currentUrl,
      firstTargetUrl: firstTargetUrl || currentUrl,
    };
  }

  throw new Error('Too many redirects');
}

async function readLimitedText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) return '';

  const chunks: Uint8Array[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      total += value.byteLength;
      if (total > MAX_BYTES) {
        chunks.push(value.subarray(0, MAX_BYTES - (total - value.byteLength)));
        await reader.cancel();
        break;
      }
      chunks.push(value);
    }
  }
  return Buffer.concat(chunks).toString('utf8');
}

export interface ExtractedPage {
  url: string;
  title: string;
  text: string;
}

export async function fetchAndExtractPage(
  rawUrl: string
): Promise<ExtractedPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const { response, finalUrl } = await fetchWithSafeRedirects(
      rawUrl,
      controller.signal
    );

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (
      !contentType.includes('text/html') &&
      !contentType.includes('text/plain') &&
      !contentType.includes('application/xhtml+xml')
    ) {
      throw new Error(`Unsupported content-type: ${contentType}`);
    }

    const html = await readLimitedText(response);
    if (contentType.includes('text/plain')) {
      return {
        url: finalUrl,
        title: finalUrl,
        text: html.slice(0, MAX_EXTRACTED_CHARS),
      };
    }

    const $ = cheerio.load(html);
    $('script, style, noscript, svg, iframe, nav, footer, header, aside').remove();

    const title = ($('title').first().text() || finalUrl).trim();
    const mainEl = $('main, article, [role="main"]').first();
    const scopeEl = mainEl.length ? mainEl : $('body');
    const rawText = scopeEl.text().replace(/\s+/g, ' ').trim();

    // Also surface direct product/page links found inside main content so shop category pages reveal exact offer URLs
    const seenLinks = new Set<string>();
    const extractedLinks: string[] = [];
    scopeEl.find('a[href]').each((_, el) => {
      if (extractedLinks.length >= 25) return false;
      const href = ($(el).attr('href') || '').trim();
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) {
        return;
      }
      const txt = $(el).text().replace(/\s+/g, ' ').trim();
      if (txt.length < 4 || /^(zobacz produkt|pokaż|więcej|sortuj|cena)/i.test(txt)) {
        return;
      }
      try {
        const abs = sanitizeUrlPathSlashes(new URL(href, finalUrl).toString());
        if (abs === finalUrl || seenLinks.has(abs)) return;
        seenLinks.add(abs);
        extractedLinks.push(`- ${txt.slice(0, 90)} -> ${abs}`);
      } catch {
        // Ignore malformed relative href
      }
    });

    const linksSection =
      extractedLinks.length > 0
        ? `\n\nZNALEZIONE LINKI NA STRONIE:\n${extractedLinks.join('\n')}`
        : '';

    return {
      url: finalUrl,
      title,
      text: `${rawText.slice(0, MAX_EXTRACTED_CHARS - Math.min(2500, linksSection.length))}${linksSection}`.slice(
        0,
        MAX_EXTRACTED_CHARS
      ),
    };
  } finally {
    clearTimeout(timer);
  }
}

export type UrlVerificationStatus =
  | 'ACTIVE_LISTING'
  | 'OUT_OF_STOCK'
  | 'SEARCH_OR_CATEGORY_PAGE'
  | 'EXPIRED_OR_NOT_FOUND'
  | 'BLOCKED_BY_SITE'
  | 'ERROR';

export interface VerifiedUrlInfo {
  originalUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  status: UrlVerificationStatus;
  title: string;
  excerpt: string;
  reason: string;
  verifiedBy: 'http' | 'playwright';
}

export function isSearchOrListingIndexUrl(urlStr: string): boolean {
  try {
    const u = new URL(urlStr);
    const full = `${u.pathname}${u.search}`.toLowerCase();
    if (
      full.includes('/d/oferta/') ||
      full.includes('/oferta/') ||
      full.includes('/items/') ||
      full.includes('/itm/') ||
      full.includes('/dp/') ||
      full.includes('/produkt/') ||
      full.includes('/product-pol-') ||
      full.includes('/pl/p/') ||
      full.includes('/products/')
    ) {
      return false;
    }

    if (
      full.includes('/q-') ||
      full.includes('?q=') ||
      full.includes('&q=') ||
      full.includes('?s=') ||
      full.includes('/sch/i.html') ||
      full.includes('/search') ||
      full.includes('/szukaj') ||
      full.includes('/catalog') ||
      full.includes('/pol_m_') ||
      full.includes('/eng_m_') ||
      full.includes('/kategoria/') ||
      full.includes('/category/') ||
      full.includes('/collections/') ||
      full.includes('search_text=') ||
      full.includes('string=') ||
      /\/oferty\/?$/.test(u.pathname.toLowerCase()) ||
      /\/ogloszenia\/?$/.test(u.pathname.toLowerCase())
    ) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

export function wasSoft404HomepageRedirect(
  firstTargetUrl: string,
  finalUrl: string
): boolean {
  try {
    const start = new URL(firstTargetUrl);
    const end = new URL(finalUrl);
    const startPath = start.pathname.replace(/\/+$/, '');
    const endPath = end.pathname.replace(/\/+$/, '');
    // If initial target pointed to a deep product/offer path (>12 chars) and redirected to root homepage
    if (
      start.hostname === end.hostname &&
      startPath.length > 12 &&
      (endPath === '' || endPath === '/pl' || endPath === '/en')
    ) {
      return true;
    }
    if (endPath.endsWith('/404') || endPath.includes('not-found')) {
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

const EXPIRED_PATTERNS = [
  'ogłoszenie nieaktualne',
  'to ogłoszenie jest już niedostępne',
  'ogłoszenie zostało usunięte',
  'ogłoszenie wygasło',
  'ta oferta nie jest już dostępna',
  'nie znaleziono strony',
  'strona o podanym adresie nie istnieje',
  'przepraszamy, ale ta strona nie istnieje',
  'strona, której szukasz, nie została znaleziona',
  'błąd 404',
  'error 404',
  'page not found',
  'listing has ended',
  'this listing was ended',
  'item is no longer available',
  '0 ogłoszeń',
  'nie znaleźliśmy żadnych ogłoszeń',
  'brak ogłoszeń spełniających',
];

const OUT_OF_STOCK_PATTERNS = [
  'produkt niedostępny',
  'towar niedostępny',
  'chwilowo niedostępny',
  'produkt chwilowo niedostępny',
  'brak w magazynie',
  'brak towaru',
  'wyprzedane',
  'produkt wyprzedany',
  'produkt wycofany',
  'powiadom o dostępności',
  'out of stock',
  'sold out',
  'currently unavailable',
];

const BLOCKED_PATTERNS = [
  'just a moment',
  'attention required',
  'enable javascript and cookies',
  'verify you are human',
  'access denied',
  'please verify you are a human',
  'captcha',
];

function classifyTextContent(params: {
  originalUrl: string;
  firstTargetUrl: string;
  finalUrl: string;
  httpStatus: number | null;
  title: string;
  bodyText: string;
  excerpt: string;
  verifiedBy: 'http' | 'playwright';
}): VerifiedUrlInfo {
  const {
    originalUrl,
    firstTargetUrl,
    finalUrl,
    httpStatus,
    title,
    bodyText,
    excerpt,
    verifiedBy,
  } = params;

  if (httpStatus === 404 || httpStatus === 410) {
    return {
      originalUrl,
      finalUrl,
      httpStatus,
      status: 'EXPIRED_OR_NOT_FOUND',
      title,
      excerpt: bodyText.slice(0, 400),
      reason: `HTTP ${httpStatus}`,
      verifiedBy,
    };
  }

  if (wasSoft404HomepageRedirect(firstTargetUrl, finalUrl)) {
    return {
      originalUrl,
      finalUrl,
      httpStatus,
      status: 'EXPIRED_OR_NOT_FOUND',
      title,
      excerpt: '',
      reason: `Soft-404: głęboki link przekierował na stronę główną (${finalUrl})`,
      verifiedBy,
    };
  }

  if (
    (httpStatus === 403 || httpStatus === 429 || httpStatus === 503) &&
    bodyText.length < 1500
  ) {
    const isSearch = isSearchOrListingIndexUrl(finalUrl);
    return {
      originalUrl,
      finalUrl,
      httpStatus,
      status: isSearch ? 'SEARCH_OR_CATEGORY_PAGE' : 'BLOCKED_BY_SITE',
      title,
      excerpt: '',
      reason: `Portal zwrócił HTTP ${httpStatus} (ochrona anty-bot / pusta treść)`,
      verifiedBy,
    };
  }

  const combinedLower = `${title} ${bodyText.slice(0, 4500)}`.toLowerCase();

  for (const pat of BLOCKED_PATTERNS) {
    if (combinedLower.includes(pat) && bodyText.length < 1800) {
      const isSearch = isSearchOrListingIndexUrl(finalUrl);
      return {
        originalUrl,
        finalUrl,
        httpStatus,
        status: isSearch ? 'SEARCH_OR_CATEGORY_PAGE' : 'BLOCKED_BY_SITE',
        title,
        excerpt: '',
        reason: `Strona chroniona wyzwaniem JS/anty-bot (${pat})`,
        verifiedBy,
      };
    }
  }

  if (bodyText.length < 120) {
    return {
      originalUrl,
      finalUrl,
      httpStatus,
      status: 'BLOCKED_BY_SITE',
      title,
      excerpt: '',
      reason: 'Strona wyrenderowała pustą treść (prawdopodobna blokada lub wymóg JS).',
      verifiedBy,
    };
  }

  for (const pat of EXPIRED_PATTERNS) {
    if (combinedLower.includes(pat)) {
      return {
        originalUrl,
        finalUrl,
        httpStatus,
        status: 'EXPIRED_OR_NOT_FOUND',
        title,
        excerpt: bodyText.slice(0, 400),
        reason: `Wykryto komunikat wygasłej/nieistniejącej strony: "${pat}"`,
        verifiedBy,
      };
    }
  }

  if (isSearchOrListingIndexUrl(finalUrl)) {
    return {
      originalUrl,
      finalUrl,
      httpStatus,
      status: 'SEARCH_OR_CATEGORY_PAGE',
      title,
      excerpt,
      reason: 'Adres prowadzi do listy wyników wyszukiwania/kategorii, a nie do konkretnej oferty.',
      verifiedBy,
    };
  }

  const seeProductMatches = combinedLower.match(/zobacz produkt|dodaj do koszyka/gi) ?? [];
  const hasStrongInStockSignal =
    /(dodaj do koszyka|do koszyka|du[żz]a ilo[śs][ćc]|w magazynie|wysy[łl]ka w 24|na stanie)/i.test(
      combinedLower
    );

  for (const pat of OUT_OF_STOCK_PATTERNS) {
    if (combinedLower.includes(pat)) {
      // Multi-product catalog/listing pages often show one sold-out card alongside many in-stock items
      if (seeProductMatches.length >= 2 && hasStrongInStockSignal) {
        return {
          originalUrl,
          finalUrl,
          httpStatus,
          status: 'SEARCH_OR_CATEGORY_PAGE',
          title,
          excerpt,
          reason: 'Strona kategorii/listy produktów (zawiera wiele ofert, w tym dostępne).',
          verifiedBy,
        };
      }
      // Single product page with active cart CTA can still mention out-of-stock on a cross-sell card below
      if (/dodaj do koszyka|do koszyka/i.test(bodyText.slice(0, 2200))) {
        continue;
      }
      return {
        originalUrl,
        finalUrl,
        httpStatus,
        status: 'OUT_OF_STOCK',
        title,
        excerpt,
        reason: `Produkt wygląda na niedostępny / wyprzedany ("${pat}")`,
        verifiedBy,
      };
    }
  }

  return {
    originalUrl,
    finalUrl,
    httpStatus,
    status: 'ACTIVE_LISTING',
    title,
    excerpt,
    reason: `Strona aktywna (${verifiedBy === 'playwright' ? 'zweryfikowana w Chromium' : 'HTTP 200'}).`,
    verifiedBy,
  };
}

export async function inspectAndVerifyUrl(
  rawUrl: string,
  options: { useBrowser?: boolean } = {}
): Promise<VerifiedUrlInfo> {
  const normalizedInput = sanitizeUrlPathSlashes(rawUrl);
  const useBrowser = options.useBrowser ?? true;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let finalUrl = normalizedInput;
  let firstTargetUrl = normalizedInput;
  let httpResult: VerifiedUrlInfo;

  try {
    const { response, finalUrl: resolved, firstTargetUrl: firstTarget } =
      await fetchWithSafeRedirects(normalizedInput, controller.signal);
    finalUrl = resolved;
    firstTargetUrl = firstTarget;

    if (response.status === 404 || response.status === 410) {
      await response.body?.cancel().catch(() => undefined);
      return {
        originalUrl: rawUrl,
        finalUrl,
        httpStatus: response.status,
        status: 'EXPIRED_OR_NOT_FOUND',
        title: '',
        excerpt: '',
        reason: `HTTP ${response.status}`,
        verifiedBy: 'http',
      };
    }

    if (wasSoft404HomepageRedirect(firstTargetUrl, finalUrl)) {
      await response.body?.cancel().catch(() => undefined);
      return {
        originalUrl: rawUrl,
        finalUrl,
        httpStatus: response.status,
        status: 'EXPIRED_OR_NOT_FOUND',
        title: '',
        excerpt: '',
        reason: `Soft-404: przekierowanie na stronę główną (${finalUrl})`,
        verifiedBy: 'http',
      };
    }

    if (
      response.status === 403 ||
      response.status === 429 ||
      response.status === 503
    ) {
      await response.body?.cancel().catch(() => undefined);
      const isSearch = isSearchOrListingIndexUrl(finalUrl);
      httpResult = {
        originalUrl: rawUrl,
        finalUrl,
        httpStatus: response.status,
        status: isSearch ? 'SEARCH_OR_CATEGORY_PAGE' : 'BLOCKED_BY_SITE',
        title: '',
        excerpt: '',
        reason: isSearch
          ? `URL wskazuje na stronę wyszukiwania (HTTP ${response.status})`
          : `Portal zwrócił HTTP ${response.status} (ochrona anty-bot)`,
        verifiedBy: 'http',
      };
    } else if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      httpResult = {
        originalUrl: rawUrl,
        finalUrl,
        httpStatus: response.status,
        status: 'ERROR',
        title: '',
        excerpt: '',
        reason: `HTTP ${response.status}`,
        verifiedBy: 'http',
      };
    } else {
      const html = await readLimitedText(response);
      const $ = cheerio.load(html);
      const title = ($('title').first().text() || '').trim();
      const ogTitle = (
        $('meta[property="og:title"]').attr('content') || ''
      ).trim();
      const metaDesc = (
        $('meta[name="description"]').attr('content') ||
        $('meta[property="og:description"]').attr('content') ||
        ''
      ).trim();

      $('script, style, noscript, svg, iframe').remove();
      const bodyText = $('body').text().replace(/\s+/g, ' ').trim();
      const excerpt = [
        ogTitle ? `OG Title: ${ogTitle}` : '',
        metaDesc ? `Meta: ${metaDesc}` : '',
        bodyText.slice(0, 2200),
      ]
        .filter(Boolean)
        .join(' | ');

      httpResult = classifyTextContent({
        originalUrl: rawUrl,
        firstTargetUrl,
        finalUrl,
        httpStatus: response.status,
        title: ogTitle || title,
        bodyText,
        excerpt,
        verifiedBy: 'http',
      });
    }
  } catch (err) {
    httpResult = {
      originalUrl: rawUrl,
      finalUrl,
      httpStatus: null,
      status: isSearchOrListingIndexUrl(finalUrl)
        ? 'SEARCH_OR_CATEGORY_PAGE'
        : 'ERROR',
      title: '',
      excerpt: '',
      reason: err instanceof Error ? err.message : 'Błąd pobierania',
      verifiedBy: 'http',
    };
  } finally {
    clearTimeout(timer);
  }

  // Upgrade via Headless Chromium (Playwright) when blocked by HTTP 403/JS or when verifying an active SPA listing
  const shouldVerifyWithBrowser =
    useBrowser &&
    (httpResult.status === 'BLOCKED_BY_SITE' ||
      (httpResult.status === 'ACTIVE_LISTING' &&
        httpResult.excerpt.length < 450));

  if (!shouldVerifyWithBrowser) {
    return httpResult;
  }

  try {
    await assertSafePublicUrl(httpResult.finalUrl);
    const rendered = await fetchRenderedPageWithPlaywright(httpResult.finalUrl);
    if (!rendered) return httpResult;

    await assertSafePublicUrl(rendered.finalUrl);
    const browserEvaluated = classifyTextContent({
      originalUrl: rawUrl,
      firstTargetUrl,
      finalUrl: rendered.finalUrl,
      httpStatus: rendered.httpStatus ?? httpResult.httpStatus,
      title: rendered.title || httpResult.title,
      bodyText: rendered.bodyText,
      excerpt: rendered.bodyText.slice(0, 2400),
      verifiedBy: 'playwright',
    });

    // If Playwright ALSO hit an anti-bot wall, keep BLOCKED_BY_SITE cleanly
    return browserEvaluated;
  } catch {
    return httpResult;
  }
}
