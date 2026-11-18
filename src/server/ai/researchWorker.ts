import { Type, type Part } from '@google/genai';
import { z } from 'zod';
import { config } from '../config.js';
import {
  addChecklistItems,
  getTaskDetail,
  replaceAssistantArtifacts,
  updateTask,
  type CreateArtifactInput,
} from '../db.js';
import { eventBus } from '../events.js';
import {
  postTextToDiscordThread,
  refreshTaskEmbedOnDiscord,
} from '../discord/bridge.js';
import type { TaskDetail } from '../types.js';
import {
  generateWithTimeout,
  getGenAI,
  loadAttachmentsAsParts,
} from './client.js';
import {
  buildBackgroundWorkerPrompt,
  buildResearchVerifierPrompt,
} from './prompts.js';
import {
  fetchAndExtractPage,
  inspectAndVerifyUrl,
  sanitizeUrlPathSlashes,
  type VerifiedUrlInfo,
} from './webExtractor.js';
import { log } from '../logger.js';

interface QueueJob {
  taskId: string;
  extraInstruction?: string;
}

const jobQueue: QueueJob[] = [];
let workerActive = false;

export function enqueueBackgroundWork(
  taskId: string,
  extraInstruction?: string
): void {
  jobQueue.push({ taskId, extraInstruction });
  void drainQueue();
}

async function drainQueue(): Promise<void> {
  if (workerActive) return;
  workerActive = true;
  try {
    while (jobQueue.length > 0) {
      const job = jobQueue.shift()!;
      await executeBackgroundJob(job);
    }
  } finally {
    workerActive = false;
  }
}

function extractUrlsFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>)"'\]]+/gi) ?? [];
  return Array.from(new Set(matches));
}

function parseSuggestedChecklist(report: string): string[] {
  const match = report.match(
    /##+\s*(?:Proponowane podzadania|Podzadania|Kolejne kroki)\s*\n([\s\S]*?)(?=\n##|$)/i
  );
  if (!match) return [];
  return match[1]
    .split('\n')
    .map((line) => line.replace(/^[-*\d.)\s\[\]xX]+/, '').trim())
    .filter((line) => line.length >= 3 && line.length <= 140)
    .slice(0, 4);
}

async function executeBackgroundJob(job: QueueJob): Promise<void> {
  const task = getTaskDetail(job.taskId);
  if (!task) return;

  const ai = getGenAI();
  if (!ai) {
    const updated = updateTask(task.id, {
      columnStatus: 'ready_inbox',
      researchReport:
        '⚠️ Brak klucza `GEMINI_API_KEY` — nie można uruchomić agenta w tle.',
    });
    if (updated) eventBus.broadcast('task:updated', updated.id, updated);
    return;
  }

  const processing = updateTask(task.id, { columnStatus: 'ai_processing' });
  if (processing) {
    eventBus.broadcast('task:updated', processing.id, processing);
  }

  try {
    log.info('ResearchWorker', `Start zadania w tle: "${task.title}"`, {
      taskId: task.id,
      type: task.backgroundTaskType,
    });
    const reportAndSources = await runResearchPass(task, job.extraInstruction);

    const nextColumn = task.columnStatus === 'done' ? 'done' : 'ready_inbox';

    let updated = updateTask(task.id, {
      columnStatus: nextColumn,
      researchReport: reportAndSources.report,
      researchSources: reportAndSources.sources,
    });

    if (updated && updated.checklist.length === 0) {
      const suggested = parseSuggestedChecklist(reportAndSources.report);
      if (suggested.length > 0) {
        addChecklistItems(updated.id, suggested);
        updated = getTaskDetail(updated.id);
      }
    }

    if (updated) {
      const extractedArtifacts = await extractArtifactsFromReport(
        updated,
        reportAndSources.report,
        reportAndSources.verifications
      );
      if (extractedArtifacts.length > 0) {
        replaceAssistantArtifacts(updated.id, extractedArtifacts);
        updated = getTaskDetail(updated.id);
        log.info('ResearchWorker', `Zapisano ${extractedArtifacts.length} zweryfikowanych artefaktów`, {
          taskId: updated?.id,
        });
      }
    }

    if (updated) {
      eventBus.broadcast('task:updated', updated.id, updated);
      await refreshTaskEmbedOnDiscord(updated);

      const sourcesLine =
        reportAndSources.sources.length > 0
          ? `\n\n**Zweryfikowane źródła:**\n${reportAndSources.sources
              .slice(0, 6)
              .map((s) => `• [${s.title}](${s.url})`)
              .join('\n')}`
          : '';

      await postTextToDiscordThread({
        task: updated,
        author: 'assistant',
        text: `✨ **Praca w tle zakończona:**\n\n${reportAndSources.report}${sourcesLine}`,
        recordInDb: true,
        withActionButtons: true,
      });
    }
  } catch (err) {
    log.error('ResearchWorker', `Błąd dla zadania ${task.id}`, err);
    const recovered = updateTask(task.id, {
      columnStatus: 'ready_inbox',
      researchReport:
        task.researchReport ||
        '⚠️ Wystąpił problem podczas pracy agenta w tle. Spróbuj ponownie lub doprecyzuj pytanie w wątku.',
    });
    if (recovered) {
      eventBus.broadcast('task:updated', recovered.id, recovered);
      await refreshTaskEmbedOnDiscord(recovered);
      await postTextToDiscordThread({
        task: recovered,
        author: 'assistant',
        text: '⚠️ Nie udało się ukończyć researchu w tle (błąd sieci lub API). Możesz kliknąć **🔍 Research**, żeby spróbować ponownie.',
        recordInDb: true,
        withActionButtons: true,
      });
    }
  }
}

async function verifyCandidateUrls(
  urls: string[],
  maxUrls = 10
): Promise<VerifiedUrlInfo[]> {
  const unique = Array.from(new Set(urls)).slice(0, maxUrls);
  if (unique.length === 0) return [];

  log.info('ResearchQA', `Weryfikuję ${unique.length} linków na żywo (HTTP + Headless Chromium)...`);
  const results: VerifiedUrlInfo[] = [];
  const batchSize = 3;
  for (let i = 0; i < unique.length; i += batchSize) {
    const batch = unique.slice(i, i + batchSize);
    const batchResults = await Promise.all(
      batch.map((url) => inspectAndVerifyUrl(url, { useBrowser: true }))
    );
    results.push(...batchResults);
  }

  for (const r of results) {
    log.info('ResearchQA', `[${r.status}] (${r.verifiedBy}) ${r.finalUrl}`, {
      http: r.httpStatus,
      reason: r.reason,
    });
  }
  return results;
}

export function replaceRedirectUrlsInText(
  text: string,
  verifications: VerifiedUrlInfo[]
): string {
  let out = text;
  // Sort longest originalUrl first and enforce exact URL boundary so bare-domain redirects
  // (e.g. https://sklep.kfd.pl -> https://sklep.kfd.pl/) never mutate deeper URL paths into "//".
  const ordered = [...verifications]
    .filter((v) => v.originalUrl && v.finalUrl && v.originalUrl !== v.finalUrl)
    .sort((a, b) => b.originalUrl.length - a.originalUrl.length);

  for (const v of ordered) {
    const cleanFinal = sanitizeUrlPathSlashes(v.finalUrl);
    const escaped = v.originalUrl.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const boundaryRx = new RegExp(`${escaped}(?=$|[\\s<>)"'\\]])`, 'g');
    out = out.replace(boundaryRx, cleanFinal);
  }
  return out;
}

function extractMentionedDomains(text: string): string[] {
  const rx = /\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:pl|com|eu|net|org|de|co\.uk))\b/gi;
  const domains = new Set<string>();
  for (const m of text.matchAll(rx)) {
    domains.add(m[1].toLowerCase().replace(/^www\./, ''));
  }
  return Array.from(domains);
}

export function collectSeedShopUrls(
  task: Pick<TaskDetail, 'userPrompt' | 'artifacts' | 'researchSources' | 'researchReport'>,
  extraInstruction?: string
): string[] {
  const instructionText = `${task.userPrompt || ''}\n${extraInstruction ?? ''}`;
  const urls = new Set<string>(extractUrlsFromText(instructionText));

  const mentionedDomains = extractMentionedDomains(instructionText);
  if (mentionedDomains.length > 0) {
    const knownUrls = [
      ...task.artifacts.map((a) => a.url).filter((u): u is string => Boolean(u)),
      ...(task.researchSources ?? []).map((s) => s.url),
      ...extractUrlsFromText(task.researchReport ?? ''),
    ];
    for (const candidate of knownUrls) {
      try {
        const host = new URL(candidate).hostname.toLowerCase().replace(/^www\./, '');
        if (mentionedDomains.some((d) => host === d || host.endsWith(`.${d}`))) {
          urls.add(sanitizeUrlPathSlashes(candidate));
        }
      } catch {
        // Ignore invalid candidate URL
      }
    }
    for (const domain of mentionedDomains) {
      urls.add(`https://${domain}/`);
    }
  }

  return Array.from(urls).slice(0, 4);
}

async function callResearchModelWithRetry(
  tag: string,
  buildRequest: (lightweightFallback: boolean) => {
    model: string;
    contents: Array<{ role: string; parts: Part[] }>;
    config: Record<string, unknown>;
  },
  primaryTimeoutMs = 55_000,
  fallbackTimeoutMs = 45_000
) {
  try {
    return await generateWithTimeout(tag, buildRequest(false), primaryTimeoutMs);
  } catch (err) {
    log.warn('ResearchWorker', `Próba 1 (${tag}) nie powiodła się — ponawiam w trybie lżejszym`, {
      err: err instanceof Error ? err.message.slice(0, 180) : String(err),
    });
    return generateWithTimeout(`${tag}-r2`, buildRequest(true), fallbackTimeoutMs);
  }
}

async function runResearchPass(
  task: TaskDetail,
  extraInstruction?: string
): Promise<{
  report: string;
  sources: Array<{ title: string; url: string }>;
  verifications: VerifiedUrlInfo[];
}> {
  const nowIso = new Date().toISOString();
  const isFollowUp = Boolean(extraInstruction?.trim());
  const imageParts =
    isFollowUp && (task.aiSummary || task.researchReport)
      ? []
      : await loadAttachmentsAsParts(task.attachments);

  // Fetch explicit user URLs AND shop pages for domains named in follow-up instructions
  const seedUrls = collectSeedShopUrls(task, extraInstruction);
  const extractedPages: string[] = [];
  const extractedSources: Array<{ title: string; url: string }> = [];
  const fetchedSet = new Set<string>();

  for (const url of seedUrls) {
    if (fetchedSet.has(url)) continue;
    fetchedSet.add(url);
    try {
      const page = await fetchAndExtractPage(url);
      extractedSources.push({ title: page.title, url: page.url });
      extractedPages.push(
        `### Treść strony: ${page.title} (${page.url})\n${page.text}`
      );
    } catch {
      // Ignore unreachable user/shop URL
    }
  }

  // If a mentioned shop domain returned a root/category page with keyword-relevant child links (e.g. a category URL),
  // follow up to 2 matching internal links on the same host so product cards inside categories are discovered quickly.
  if (isFollowUp && extractedPages.length > 0 && extractedPages.length < 4) {
    const queryKeywords = `${task.title} ${extraInstruction ?? ''}`
      .toLowerCase()
      .split(/[^a-z0-9ąćęłńóśźż]+/i)
      .filter((w) => w.length >= 4 && !/^(sklep|sklepie|zamow|przygotuj|znajdz|link|produkt|oficjalny)$/i.test(w));

    const childCandidates: Array<{ url: string; score: number }> = [];
    for (const pageBlock of extractedPages) {
      for (const candidateUrl of extractUrlsFromText(pageBlock)) {
        if (fetchedSet.has(candidateUrl)) continue;
        const lowerUrl = candidateUrl.toLowerCase();
        const score = queryKeywords.reduce(
          (acc, kw) => (lowerUrl.includes(kw.slice(0, 5)) ? acc + 1 : acc),
          0
        );
        if (score > 0) {
          childCandidates.push({ url: candidateUrl, score });
        }
      }
    }
    childCandidates.sort((a, b) => b.score - a.score);
    for (const child of childCandidates.slice(0, 2)) {
      if (fetchedSet.has(child.url)) continue;
      fetchedSet.add(child.url);
      try {
        const subPage = await fetchAndExtractPage(child.url);
        extractedSources.push({ title: subPage.title, url: subPage.url });
        extractedPages.push(
          `### Treść podstrony: ${subPage.title} (${subPage.url})\n${subPage.text}`
        );
      } catch {
        // Ignore unreachable child URL
      }
    }
  }

  const buildContextText = (compact: boolean): string => {
    const reportLimit = compact ? 900 : isFollowUp ? 1800 : 2800;
    const prevReport = task.researchReport
      ? task.researchReport.slice(0, reportLimit)
      : '';
    return [
      `TYTUŁ ZADANIA: ${task.title}`,
      `TYP PRACY: ${task.backgroundTaskType}`,
      `ORYGINALNE POLECENIE UŻYTKOWNIKA: ${task.userPrompt || '(brak tekstu — tylko screen)'}`,
      `KONTEKST Z TRIAGE: ${task.aiSummary}`,
      task.backgroundPrompt ? `PLAN PRACY W TLE: ${task.backgroundPrompt}` : '',
      extraInstruction
        ? `NOWA INSTRUKCJA OD UŻYTKOWNIKA: ${extraInstruction}`
        : '',
      prevReport
        ? `POPRZEDNI RAPORT (skrót do aktualizacji):\n${prevReport}`
        : '',
      extractedPages.length > 0
        ? `POBRANA TREŚĆ STRON SKLEPÓW / LINKÓW:\n${extractedPages.join('\n\n').slice(0, compact ? 4000 : 9000)}`
        : '',
    ]
      .filter(Boolean)
      .join('\n\n');
  };

  const useSearch =
    task.backgroundTaskType === 'WEB_RESEARCH' || Boolean(extraInstruction);

  // STAGE 1: Initial search & draft (with lightweight retry on 504/timeout)
  const response = await callResearchModelWithRetry(
    `research-${task.id.slice(0, 8)}`,
    (lightweight) => ({
      model: config.GEMINI_RESEARCH_MODEL,
      contents: [
        {
          role: 'user',
          parts: [
            ...(lightweight ? [] : imageParts),
            { text: buildContextText(lightweight) },
          ],
        },
      ],
      config: {
        systemInstruction: buildBackgroundWorkerPrompt(nowIso, config.TIMEZONE),
        tools: useSearch ? [{ googleSearch: {} }] : undefined,
      },
    }),
    55_000,
    45_000
  );

  let draftReport =
    response.text?.trim() || 'Brak wygenerowanej treści raportu.';

  if (!useSearch) {
    return { report: draftReport, sources: extractedSources, verifications: [] };
  }

  // Collect all candidate URLs from grounding metadata, report text, and directly discovered shop pages
  const chunkUrls = new Map<string, string>();
  const chunks =
    response.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  for (const chunk of chunks) {
    const uri = chunk.web?.uri;
    const title = chunk.web?.title || uri || '';
    if (uri) chunkUrls.set(uri, title);
  }
  for (const url of extractUrlsFromText(draftReport)) {
    if (!chunkUrls.has(url)) chunkUrls.set(url, url);
  }
  for (const s of extractedSources) {
    if (!chunkUrls.has(s.url)) chunkUrls.set(s.url, s.title);
  }

  let verifications = await verifyCandidateUrls(Array.from(chunkUrls.keys()));

  // STAGE 2: Auto-retry if we found 0 ACTIVE_LISTING URLs (e.g. only search pages or expired offers)
  const activeCount = verifications.filter(
    (v) => v.status === 'ACTIVE_LISTING'
  ).length;

  if (activeCount === 0 && verifications.length > 0) {
    log.info(
      'ResearchQA',
      'Brak potwierdzonych bezpośrednich ofert — uruchamiam drugą turę wyszukiwania po bezpośrednich URL-ach...'
    );
    const failedSummary = verifications
      .map((v) => `- ${v.finalUrl} -> ${v.status} (${v.reason})`)
      .join('\n');

    const retryResponse = await callResearchModelWithRetry(
      `research-retry-${task.id.slice(0, 8)}`,
      (lightweight) => ({
        model: config.GEMINI_RESEARCH_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              ...(lightweight ? [] : imageParts),
              {
                text: `${buildContextText(lightweight)}\n\nPOPRZEDNIE WYSZUKIWANIE ZWRÓCIŁO GŁÓWNIE STRONY WYSZUKIWANIA LUB WYGASŁE LINKI:\n${failedSummary}\n\nWYKONAJ PONOWNE, BARDZIEJ PRECYZYJNE WYSZUKIWANIE (np. z użyciem konkretnych fraz ogłoszeń lub site:olx.pl/d/oferta, site:allegrolokalnie.pl/oferta, site:vinted.pl/items, site:ebay.com/itm, konkretnych sklepów). Podaj wyłącznie konkretne, aktywne oferty lub rozwiązania.`,
              },
            ],
          },
        ],
        config: {
          systemInstruction: buildBackgroundWorkerPrompt(
            nowIso,
            config.TIMEZONE
          ),
          tools: [{ googleSearch: {} }],
        },
      }),
      55_000,
      45_000
    );

    const retryText = retryResponse.text?.trim();
    if (retryText) {
      const retryUrlMap = new Map<string, string>();
      const retryChunks =
        retryResponse.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
      for (const chunk of retryChunks) {
        if (chunk.web?.uri) {
          retryUrlMap.set(chunk.web.uri, chunk.web.title || chunk.web.uri);
        }
      }
      for (const url of extractUrlsFromText(retryText)) {
        if (!retryUrlMap.has(url)) retryUrlMap.set(url, url);
      }

      const retryNewUrls = Array.from(retryUrlMap.keys()).filter(
        (u) => !chunkUrls.has(u)
      );
      if (retryNewUrls.length > 0) {
        const retryVerifications = await verifyCandidateUrls(retryNewUrls, 8);
        verifications = [...verifications, ...retryVerifications];
        for (const [u, t] of retryUrlMap) chunkUrls.set(u, t);
      }
      draftReport = `${draftReport}\n\n---\n\n### Wyniki dodatkowego wyszukiwania\n${retryText}`;
    }
  }

  // STAGE 3: Strict QA Verification & Synthesis Pass
  if (verifications.length > 0) {
    const verificationReport = verifications.map((v, idx) => ({
      index: idx + 1,
      originalUrl: v.originalUrl,
      finalUrl: v.finalUrl,
      status: v.status,
      httpStatus: v.httpStatus,
      reason: v.reason,
      pageTitle: v.title,
      realPageExcerpt: v.excerpt.slice(0, 1600),
    }));

    const verifiedResponse = await callResearchModelWithRetry(
      `research-qa-${task.id.slice(0, 8)}`,
      (lightweight) => ({
        model: config.GEMINI_RESEARCH_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `ZADANIE UŻYTKOWNIKA: ${task.title} (${extraInstruction || task.userPrompt || task.aiSummary})

WSTĘPNY RAPORT DO AUDYTU:
${lightweight ? draftReport.slice(0, 5000) : draftReport}

WYNIKI RZECZYWISTEJ WERYFIKACJI LINKÓW NA ŻYWO (JSON):
${JSON.stringify(verificationReport, null, 2)}`,
              },
            ],
          },
        ],
        config: {
          systemInstruction: buildResearchVerifierPrompt(
            nowIso,
            config.TIMEZONE
          ),
        },
      }),
      55_000,
      45_000
    );

    const auditedText = verifiedResponse.text?.trim();
    if (auditedText && auditedText.length > 60) {
      draftReport = auditedText;
    }
  }

  // Belt & suspenders: replace any remaining redirect URLs with resolved finalUrls
  draftReport = replaceRedirectUrlsInText(draftReport, verifications);

  // Build clean verified sources list (exclude dead/error URLs)
  const finalSourcesMap = new Map<string, { title: string; url: string }>();
  for (const s of extractedSources) {
    finalSourcesMap.set(s.url, s);
  }
  for (const v of verifications) {
    if (
      v.status === 'EXPIRED_OR_NOT_FOUND' ||
      v.status === 'OUT_OF_STOCK' ||
      v.status === 'ERROR' ||
      !v.finalUrl ||
      v.finalUrl.includes('vertexaisearch.cloud.google.com')
    ) {
      continue;
    }
    const label =
      v.title ||
      chunkUrls.get(v.originalUrl) ||
      new URL(v.finalUrl).hostname;
    const prefix =
      v.status === 'ACTIVE_LISTING'
        ? '✅ '
        : v.status === 'SEARCH_OR_CATEGORY_PAGE'
          ? '🔎 '
          : '⚠️ ';
    finalSourcesMap.set(v.finalUrl, {
      title: `${prefix}${label}`.slice(0, 100),
      url: v.finalUrl,
    });
  }

  return {
    report: draftReport,
    sources: Array.from(finalSourcesMap.values()).slice(0, 8),
    verifications,
  };
}

const ExtractedArtifactsSchema = z.object({
  artifacts: z.array(
    z.object({
      type: z.enum(['link', 'message', 'note']),
      title: z.string().min(1),
      content: z.string().default(''),
      url: z.string().nullable().default(null),
      price: z.string().nullable().default(null),
      platform: z.string().nullable().default(null),
      status: z.string().nullable().default(null),
    })
  ),
});

async function extractArtifactsFromReport(
  task: TaskDetail,
  report: string,
  verifications: VerifiedUrlInfo[]
): Promise<CreateArtifactInput[]> {
  try {
    const response = await generateWithTimeout(
      `artifacts-${task.id.slice(0, 8)}`,
      {
        model: config.GEMINI_TRIAGE_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Z poniższego raportu wyodrębnij wyłącznie pewne, gotowe do użycia ARTEFAKTY dla użytkownika:
- "link": konkretne oferty produktów, ogłoszenia, bezpośrednie strony produktów w sklepach ORAZ pojedyncze karty produktu na porównywarkach cenowych (np. https://www.ceneo.pl/125396295 — to konkretna karta produktu z listą ofert, nie strona kategorii).
  * ZAWSZE zachowaj kolejność od NAJKORZYSTNIEJSZEJ / rekomendowanej oferty (najpierw najtańsze i zweryfikowane oferty, np. oficjalny sklep lub zweryfikowany sklep, potem porównywarka Ceneo).
  * NIE wyodrębniaj stron wyników wyszukiwania, kategorii ani ofert wyprzedanych/niedostępnych.
  * Jeśli raport wyraźnie odradza daną ofertę jako przepłaconą/nieopłacalną (znacznie droższą od zweryfikowanej oferty z raportu), NIE dodawaj jej jako jedynego ani głównego linku — pomiń ją, gdy dostępne są lepsze zweryfikowane opcje, albo wyraźnie oznacz w statusie jako "droższa alternatywa".
  * Wypełnij price (np. "139,99 zł"), platform (np. "Sklep KFD", "Ceneo"), status (np. "zweryfikowana").
- "message": gotowe szablony wiadomości/maili/odpowiedzi do skopiowania i wysłania (w "content" umieść CZYSTĄ treść wiadomości gotową do wklejenia, bez cudzysłowów i nagłówków typu "Wariant A:").
- "note": konkretne dane referencyjne do szybkiego podglądu (np. kod rabatowy, dokładny numer modelu, dane do przelewu), jeśli występują. Nie dubluj całego raportu jako notatki.

ZADANIE: ${task.title}

RAPORT:
${report.slice(0, 10000)}`,
              },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              artifacts: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    type: { type: Type.STRING, enum: ['link', 'message', 'note'] },
                    title: { type: Type.STRING },
                    content: { type: Type.STRING },
                    url: { type: Type.STRING, nullable: true },
                    price: { type: Type.STRING, nullable: true },
                    platform: { type: Type.STRING, nullable: true },
                    status: { type: Type.STRING, nullable: true },
                  },
                  required: ['type', 'title', 'content'],
                },
              },
            },
            required: ['artifacts'],
          },
        },
      },
      30_000
    );

    const parsed = ExtractedArtifactsSchema.parse(
      JSON.parse(response.text ?? '{"artifacts":[]}')
    );

    // Build verification lookup map (normalized paths prevent "//" cache misses)
    const verifiedMap = new Map<string, VerifiedUrlInfo>();
    for (const v of verifications) {
      verifiedMap.set(v.originalUrl, v);
      verifiedMap.set(sanitizeUrlPathSlashes(v.originalUrl), v);
      verifiedMap.set(v.finalUrl, v);
      verifiedMap.set(sanitizeUrlPathSlashes(v.finalUrl), v);
    }

    const approvedLinks: Array<{ input: CreateArtifactInput; priority: number }> = [];
    const approvedOther: CreateArtifactInput[] = [];

    for (const a of parsed.artifacts.slice(0, 12)) {
      const meta: Record<string, string> = {};
      if (a.price) meta.price = a.price;
      if (a.platform) meta.platform = a.platform;

      if (a.type !== 'link') {
        if (a.status) meta.status = a.status;
        approvedOther.push({
          type: a.type,
          title: a.title.slice(0, 120),
          content: a.content.slice(0, 4000),
          url: null,
          meta,
          createdBy: 'assistant',
        });
        continue;
      }

      if (!a.url || !a.url.startsWith('http')) {
        continue;
      }

      const cleanUrl = sanitizeUrlPathSlashes(a.url);
      let v = verifiedMap.get(cleanUrl) ?? verifiedMap.get(a.url);
      if (!v) {
        v = await inspectAndVerifyUrl(cleanUrl, { useBrowser: true });
        verifiedMap.set(cleanUrl, v);
      }

      // Hard Artifact Quality Gate: block 404, soft-404, out-of-stock, search/category pages, and errors
      if (
        v.status === 'EXPIRED_OR_NOT_FOUND' ||
        v.status === 'OUT_OF_STOCK' ||
        v.status === 'SEARCH_OR_CATEGORY_PAGE' ||
        v.status === 'ERROR'
      ) {
        log.info('ArtifactGate', `Odrzucono artefakt link: ${v.finalUrl} (${v.status})`, {
          reason: v.reason,
        });
        continue;
      }

      meta.status =
        v.status === 'ACTIVE_LISTING'
          ? v.verifiedBy === 'playwright'
            ? 'zweryfikowana (Chromium)'
            : 'zweryfikowana'
          : 'sprawdź na portalu';

      const finalCleanUrl = sanitizeUrlPathSlashes(v.finalUrl);
      approvedLinks.push({
        priority: v.status === 'ACTIVE_LISTING' ? 0 : 1,
        input: {
          type: 'link',
          title: a.title.slice(0, 120),
          content: a.content.slice(0, 4000),
          url: finalCleanUrl,
          meta,
          createdBy: 'assistant',
        },
      });
    }

    // Put fully verified ACTIVE_LISTING offers before blocked portal fallbacks
    approvedLinks.sort((a, b) => a.priority - b.priority);
    return [...approvedLinks.map((x) => x.input), ...approvedOther];
  } catch (err) {
    log.error('ResearchWorker', 'Błąd ekstrakcji artefaktów', err);
    return [];
  }
}
