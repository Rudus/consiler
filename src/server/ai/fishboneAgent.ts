import crypto from 'node:crypto';
import { Type, type Part } from '@google/genai';
import { z } from 'zod';
import { config } from '../config.js';
import {
  assignArtifactToBone,
  getTaskDetail,
  replaceBoneAssistantArtifacts,
  saveTaskFishbone,
  updateFishboneBone,
  type CreateArtifactInput,
  type CreateFishboneBoneInput,
} from '../db.js';
import {
  postTextToDiscordThread,
  refreshTaskEmbedOnDiscord,
} from '../discord/bridge.js';
import { eventBus } from '../events.js';
import { log } from '../logger.js';
import type {
  FishboneBone,
  FishboneBoneStatus,
  FishboneOwner,
  TaskDetail,
} from '../types.js';
import {
  generateWithTimeout,
  getGenAI,
  loadAttachmentsAsParts,
} from './client.js';
import { replaceRedirectUrlsInText } from './researchWorker.js';
import {
  inspectAndVerifyUrl,
  sanitizeUrlPathSlashes,
  type VerifiedUrlInfo,
} from './webExtractor.js';

const activeSpineRuns = new Set<string>();

const FishbonePlanSchema = z.object({
  headGoal: z.string().min(1),
  tailOutcome: z.string().min(1),
  bones: z
    .array(
      z.object({
        title: z.string().min(1),
        description: z.string().default(''),
        owner: z.enum(['ai', 'user', 'shared']),
        aiPrompt: z.string().nullable().default(null),
        subItems: z
          .array(
            z.object({
              text: z.string().min(1),
              isOption: z.boolean().default(false),
            })
          )
          .default([]),
      })
    )
    .min(2)
    .max(8),
});

const BoneArtifactsSchema = z.object({
  summary: z.string().min(1),
  subItems: z
    .array(
      z.object({
        text: z.string().min(1),
        isOption: z.boolean().default(false),
      })
    )
    .default([]),
  artifacts: z
    .array(
      z.object({
        type: z.enum(['link', 'message', 'note']),
        title: z.string().min(1),
        content: z.string().default(''),
        url: z.string().nullable().default(null),
        price: z.string().nullable().default(null),
        platform: z.string().nullable().default(null),
        status: z.string().nullable().default(null),
      })
    )
    .default([]),
});

function extractUrlsFromText(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>)"'\]]+/gi) ?? [];
  return Array.from(new Set(matches));
}

export function buildFallbackFishbone(
  task: TaskDetail
): {
  headGoal: string;
  tailOutcome: string;
  bones: CreateFishboneBoneInput[];
} {
  const headGoal = task.title;
  const tailOutcome =
    task.category === 'Zakupy'
      ? 'Wybrany wariant zamówiony i opłacony'
      : 'Sprawa w pełni zamknięta i zweryfikowana';

  const existingChecks = task.checklist.map((c) => ({
    text: c.text,
    completed: c.completed,
    isOption: false,
  }));

  const hasExistingResearch =
    Boolean(task.researchReport) || task.artifacts.length > 0;

  const bones: CreateFishboneBoneInput[] = [
    {
      title: '1. Zebranie opcji i rozeznanie (AI)',
      description:
        'Przeszukanie sieci, porównanie dostępnych wariantów i przygotowanie artefaktów (linków, cen lub szkiców).',
      owner: 'ai',
      status: hasExistingResearch ? 'done' : 'pending',
      aiPrompt:
        task.backgroundPrompt ||
        `Znajdź konkretne rozwiązania, oferty lub materiały dla zadania: ${task.title}. ${task.userPrompt}`,
      aiResult: hasExistingResearch
        ? 'Wstępny research oraz artefakty zostały przygotowane.'
        : null,
      subItems: [
        {
          text: 'Weryfikacja dostępnych ofert / źródeł',
          completed: hasExistingResearch,
        },
      ],
    },
    {
      title: '2. Wybór wariantu i decyzja',
      description:
        'Przejrzyj wygenerowane przez AI artefakty lub opcje na tej ości i wskaż docelowy wariant.',
      owner: 'shared',
      status: hasExistingResearch ? 'needs_user' : 'pending',
      aiPrompt:
        'Zestaw 2-3 konkretne warianty do wyboru przez użytkownika wraz z krótką rekomendacją.',
      subItems:
        existingChecks.length > 0
          ? existingChecks.slice(0, 3)
          : [
              {
                text: 'Wariant A: Opcja rekomendowana (najlepszy stosunek ceny do jakości)',
                isOption: true,
              },
              {
                text: 'Wariant B: Alternatywa budżetowa / szybsza',
                isOption: true,
              },
            ],
    },
    {
      title: '3. Przygotowanie realizacji (AI)',
      description:
        'Na podstawie Twojego wyboru AI przygotowuje gotowy szkic wiadomości, instrukcję lub sesję zakupu.',
      owner: 'ai',
      status: 'pending',
      aiPrompt:
        'Na podstawie wybranego przez użytkownika wariantu przygotuj finalny szkic wiadomości, podsumowanie kroków lub link gotowy do koszyka.',
      subItems: [
        {
          text: 'Przygotowanie finalnego artefaktu wykonawczego',
          completed: false,
        },
      ],
    },
    {
      title: '4. Finalizacja przez Ciebie',
      description:
        'Ostateczne zatwierdzenie, wysłanie wiadomości lub dokończenie płatności.',
      owner: 'user',
      status: 'pending',
      subItems:
        existingChecks.length > 3
          ? existingChecks.slice(3)
          : [
              {
                text: 'Potwierdź wykonanie i zamknij sprawę',
                completed: false,
              },
            ],
    },
  ];

  return { headGoal, tailOutcome, bones };
}

export async function generateFishboneForTask(
  taskId: string,
  options?: {
    customHint?: string;
    pinAsBigThing?: boolean;
    autoAdvanceAi?: boolean;
  }
): Promise<TaskDetail | null> {
  const task = getTaskDetail(taskId);
  if (!task) return null;

  const ai = getGenAI();
  let plan = buildFallbackFishbone(task);

  if (ai) {
    try {
      const imageParts = await loadAttachmentsAsParts(task.attachments);
      const artifactsText =
        task.artifacts.length > 0
          ? task.artifacts
              .map(
                (a) =>
                  `- [${a.type}] ${a.title}${a.meta?.price ? ` (${a.meta.price})` : ''}${a.url ? ` -> ${a.url}` : ''}`
              )
              .join('\n')
          : '(brak)';
      const checklistText =
        task.checklist.length > 0
          ? task.checklist.map((c) => `- ${c.text}`).join('\n')
          : '(brak)';

      const response = await generateWithTimeout(
        `fishbone-plan-${task.id.slice(0, 8)}`,
        {
          model: config.GEMINI_TRIAGE_MODEL,
          contents: [
            {
              role: 'user',
              parts: [
                ...imageParts,
                {
                  text: `Rozbij poniższe zadanie/problem na hybrydowy Graf Rybiej Ości (Fishbone / Anti-Paralysis: "Break One Big Task Into Bites"), w którym UŻYTKOWNIK i AI współpracują nad kolejnymi stadiami problemu od Głowy (headGoal) do Ogona (tailOutcome).

ZADANIE: ${task.title}
KATEGORIA: ${task.category}
OPIS UŻYTKOWNIKA: ${task.userPrompt || '(brak)'}
PODSUMOWANIE AI: ${task.aiSummary || '(brak)'}
DOTYCHCZASOWY RAPORT: ${(task.researchReport ?? '').slice(0, 2500) || '(brak)'}
DOTYCHCZASOWE ARTEFAKTY:\n${artifactsText}
DOTYCHCZASOWA CHECKLISTA:\n${checklistText}
${options?.customHint ? `\nDODATKOWA WSKAZÓWKA UŻYTKOWNIKA: ${options.customHint}` : ''}

ZASADY PROJEKTOWANIA OŚCI (4 do 6 ości w kolejności chronologicznej od Głowy do Ogona):
1. "headGoal": krótka, konkretna nazwa głównego wyzwania (do wpisania w Głowę Ryby).
2. "tailOutcome": konkretny stan końcowy oznaczający 100% sukcesu (do wpisania w Ogon Ryby).
3. "bones": 4-6 logicznych etapów (ości) prowadzących od Głowy do Ogona. Każda ość ma:
   - "title": zwięzła nazwa etapu (max 55 znaków, np. "Rozeznanie i znalezienie 3 ofert", "Wybór wariantu i budżetu", "Przygotowanie pisma / koszyka", "Wysłanie i odbiór").
   - "description": 1-2 zdania co dokładnie dzieje się na tej ości.
   - "owner":
     * "ai" — etap, który AI może wykonać w tle samodzielnie (research w sieci, porównanie ofert, weryfikacja przepisów/wymogów, przygotowanie szkicu wiadomości lub notatki).
     * "shared" — etap wspólny / decyzyjny: AI przygotowuje warianty lub artefakty, a użytkownik wybiera jeden z nich (np. wybór konkretnej oferty, akceptacja wariantu odpowiedzi).
     * "user" — etap czysto ludzki/fizyczny (np. pomiar w domu, telefon, finalna płatność, spakowanie paczki).
   - "aiPrompt": dla owner="ai" lub "shared" napisz precyzyjne polecenie dla agenta AI (co ma znaleźć w sieci, jakie artefakty wygenerować — np. linki do ofert z cenami, gotowy szablon wiadomości, notatkę porównawczą). Dla owner="user" ustaw null.
   - "subItems": 2-4 konkretne pod-kroki lub warianty na tej ości. Jeśli ość wymaga decyzji użytkownika między opcjami, ustaw dla tych opcji "isOption": true.
4. Układaj ości tak, aby AI przejmowało ciężar researchu i przygotowania materiałów na początku oraz po decyzji użytkownika (np. Ość 1: AI/Shared -> Ość 2: User/Shared decyzja -> Ość 3: AI przygotowanie pod wybrany wariant -> Ość 4: User finalizacja).`,
                },
              ],
            },
          ],
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                headGoal: { type: Type.STRING },
                tailOutcome: { type: Type.STRING },
                bones: {
                  type: Type.ARRAY,
                  items: {
                    type: Type.OBJECT,
                    properties: {
                      title: { type: Type.STRING },
                      description: { type: Type.STRING },
                      owner: {
                        type: Type.STRING,
                        enum: ['ai', 'user', 'shared'],
                      },
                      aiPrompt: { type: Type.STRING, nullable: true },
                      subItems: {
                        type: Type.ARRAY,
                        items: {
                          type: Type.OBJECT,
                          properties: {
                            text: { type: Type.STRING },
                            isOption: { type: Type.BOOLEAN },
                          },
                          required: ['text', 'isOption'],
                        },
                      },
                    },
                    required: ['title', 'description', 'owner', 'subItems'],
                  },
                },
              },
              required: ['headGoal', 'tailOutcome', 'bones'],
            },
          },
        },
        35_000
      );

      const parsed = FishbonePlanSchema.parse(
        JSON.parse(response.text ?? '{}')
      );
      plan = {
        headGoal: parsed.headGoal,
        tailOutcome: parsed.tailOutcome,
        bones: parsed.bones.map((b) => ({
          title: b.title,
          description: b.description,
          owner: b.owner,
          status: 'pending',
          aiPrompt: b.aiPrompt,
          subItems: b.subItems.map((s) => ({
            text: s.text,
            completed: false,
            isOption: s.isOption,
            selected: false,
          })),
        })),
      };
    } catch (err) {
      log.warn(
        'FishboneAgent',
        `Nie udało się wygenerować planu przez Gemini — używam planu domyślnego`,
        err
      );
    }
  }

  let saved = saveTaskFishbone(taskId, {
    headGoal: plan.headGoal,
    tailOutcome: plan.tailOutcome,
    isPinnedBigThing: options?.pinAsBigThing,
    bones: plan.bones,
  });

  // If the task already had unattached artifacts from initial triage/research,
  // attach them to the first AI/shared bone so they appear immediately on the graph.
  if (saved && saved.fishbone && saved.artifacts.length > 0) {
    const firstAiOrSharedBone =
      saved.fishbone.bones.find(
        (b) => b.owner === 'ai' || b.owner === 'shared'
      ) ?? saved.fishbone.bones[0];

    if (firstAiOrSharedBone) {
      for (const art of saved.artifacts) {
        if (!art.boneId) {
          assignArtifactToBone(taskId, art.id, firstAiOrSharedBone.id);
        }
      }
      saved = getTaskDetail(taskId);
    }
  }

  if (saved) {
    eventBus.broadcast('task:updated', saved.id, saved);
    await refreshTaskEmbedOnDiscord(saved);

    if (options?.autoAdvanceAi !== false) {
      void advanceFishboneAiQueue(taskId);
    }
  }

  return saved;
}

export async function advanceFishboneAiQueue(taskId: string): Promise<void> {
  if (activeSpineRuns.has(taskId)) return;
  activeSpineRuns.add(taskId);

  try {
    for (let step = 0; step < 8; step++) {
      const task = getTaskDetail(taskId);
      if (!task || !task.fishbone) break;

      const bones = task.fishbone.bones;
      const nextBone = bones.find((b) => b.status !== 'done');
      if (!nextBone) {
        break;
      }

      // If this bone is already waiting for the user, stop advancing
      if (nextBone.status === 'needs_user') {
        break;
      }

      // If this bone belongs purely to the user, mark it as 'needs_user' and wait
      if (nextBone.owner === 'user') {
        updateFishboneBone(taskId, nextBone.id, { status: 'needs_user' });
        const updated = getTaskDetail(taskId);
        if (updated) {
          eventBus.broadcast('task:updated', updated.id, updated);
        }
        break;
      }

      // Otherwise owner is 'ai' or 'shared' and status is 'pending' -> execute AI on this bone!
      await executeFishboneBoneAi(taskId, nextBone.id);

      const afterRun = getTaskDetail(taskId);
      const refreshedBone = afterRun?.fishbone?.bones.find(
        (b) => b.id === nextBone.id
      );
      if (!refreshedBone || refreshedBone.status !== 'done') {
        // Bone transitioned to 'needs_user' (e.g. shared decision stage) -> stop and wait for user choice!
        break;
      }
    }
  } finally {
    activeSpineRuns.delete(taskId);
  }
}

function buildUpstreamSpineContext(
  task: TaskDetail,
  targetBone: FishboneBone
): string {
  if (!task.fishbone) return '';
  const lines: string[] = [
    `GŁÓWNY PROBLEM (Głowa ryby): ${task.fishbone.headGoal}`,
    `CEL KOŃCOWY (Ogon ryby): ${task.fishbone.tailOutcome}`,
  ];

  const earlierBones = task.fishbone.bones.filter(
    (b) => b.position < targetBone.position
  );

  if (earlierBones.length > 0) {
    lines.push('\nDOTYCHCZASOWE USTALENIA NA WCZEŚNIEJSZYCH OŚCIACH:');
    for (const b of earlierBones) {
      const selectedArt = b.selectedArtifactId
        ? task.artifacts.find((a) => a.id === b.selectedArtifactId)
        : null;
      const boneArts = task.artifacts.filter((a) => a.boneId === b.id);
      const chosenOptions = b.subItems.filter(
        (s) => s.selected || (s.isOption && s.completed)
      );

      lines.push(
        `- Ość #${b.position + 1} "${b.title}" [${b.status.toUpperCase()}]:`
      );
      if (b.aiResult) {
        lines.push(`  Wynik: ${b.aiResult.slice(0, 600)}`);
      }
      if (selectedArt) {
        lines.push(
          `  ★ WYBRANY PRZEZ UŻYTKOWNIKA ARTEFAKT: "${selectedArt.title}"${selectedArt.meta?.price ? ` (${selectedArt.meta.price})` : ''}${selectedArt.url ? ` URL: ${selectedArt.url}` : ''} — ${selectedArt.content}`
        );
      } else if (boneArts.length > 0) {
        lines.push(
          `  Przypięte artefakty: ${boneArts
            .map(
              (a) =>
                `"${a.title}"${a.meta?.price ? ` (${a.meta.price})` : ''}${a.url ? ` [${a.url}]` : ''}`
            )
            .join('; ')}`
        );
      }
      if (chosenOptions.length > 0) {
        lines.push(
          `  ★ WYBRANA PRZEZ UŻYTKOWNIKA OPCJA: ${chosenOptions.map((o) => o.text).join(', ')}`
        );
      }
    }
  }

  return lines.join('\n');
}

export async function executeFishboneBoneAi(
  taskId: string,
  boneId: string,
  customInstruction?: string
): Promise<TaskDetail | null> {
  const task = getTaskDetail(taskId);
  if (!task || !task.fishbone) return task;

  const bone = task.fishbone.bones.find((b) => b.id === boneId);
  if (!bone) return task;

  updateFishboneBone(taskId, boneId, { status: 'ai_working' });
  const workingTask = getTaskDetail(taskId);
  if (workingTask) {
    eventBus.broadcast('task:updated', workingTask.id, workingTask);
  }

  const ai = getGenAI();
  if (!ai) {
    const fallbackStatus: FishboneBoneStatus =
      bone.owner === 'shared' ? 'needs_user' : 'done';
    updateFishboneBone(taskId, boneId, {
      status: fallbackStatus,
      aiResult:
        bone.aiResult ||
        'Etap przeanalizowany (tryb offline — brak klucza GEMINI_API_KEY).',
    });
    const updated = getTaskDetail(taskId);
    if (updated) eventBus.broadcast('task:updated', updated.id, updated);
    return updated;
  }

  try {
    const nowIso = new Date().toISOString();
    const upstreamContext = buildUpstreamSpineContext(task, bone);
    const imageParts: Part[] =
      bone.position === 0 ? await loadAttachmentsAsParts(task.attachments) : [];

    const stepPrompt = [
      `Jesteś agentem AI współpracującym z użytkownikiem nad rozwiązaniem problemu metodą Rybiej Ości (Fishbone).`,
      `AKTUALNY CZAS: ${nowIso} (${config.TIMEZONE}).`,
      upstreamContext,
      `\nTERAZ WYKONUJESZ OŚĆ #${bone.position + 1}: "${bone.title}" (Tryb: ${bone.owner.toUpperCase()})`,
      `OPIS TEGO ETAPU: ${bone.description}`,
      bone.aiPrompt ? `INSTRUKCJA DLA TEJ OŚCI: ${bone.aiPrompt}` : '',
      customInstruction
        ? `DODATKOWE POLECENIE UŻYTKOWNIKA: ${customInstruction}`
        : '',
      task.userPrompt ? `KONTEKST ZADANIA: ${task.userPrompt}` : '',
      `\nTWOJE ZADANIE NA TEJ OŚCI:
1. Wykonaj konkretną pracę przypisaną do tej ości (korzystając z wyszukiwarki Google, jeśli potrzebujesz aktualnych ofert, cen w PLN, linków do sklepów, przepisów lub faktów).
2. Jeśli na wcześniejszej ości użytkownik wybrał już konkretny wariant lub artefakt (oznaczony ★), bezwzględnie oprzyj się na jego wyborze!
3. Podaj zwięzły, konkretny rezultat dla tej ości (2-5 punktów lub krótka rekomendacja) oraz konkretne linki lub gotową treść wiadomości/notatki, tak aby mogły zostać przypięte jako ARTEFAKTY bezpośrednio na tej ości.`,
    ]
      .filter(Boolean)
      .join('\n');

    const searchResponse = await generateWithTimeout(
      `bone-work-${boneId.slice(0, 8)}`,
      {
        model: config.GEMINI_RESEARCH_MODEL,
        contents: [
          {
            role: 'user',
            parts: [...imageParts, { text: stepPrompt }],
          },
        ],
        config: {
          tools: [{ googleSearch: {} }],
        },
      },
      50_000
    );

    let rawFinding =
      searchResponse.text?.trim() || 'Etap przeanalizowany przez AI.';

    // Collect and verify any URLs found during this bone's research
    const candidateUrls = new Set<string>(extractUrlsFromText(rawFinding));
    const chunks =
      searchResponse.candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
    for (const chunk of chunks) {
      if (chunk.web?.uri) candidateUrls.add(chunk.web.uri);
    }

    const verifications: VerifiedUrlInfo[] = [];
    const urlsToVerify = Array.from(candidateUrls).slice(0, 6);
    for (let i = 0; i < urlsToVerify.length; i += 3) {
      const batch = urlsToVerify.slice(i, i + 3);
      const batchRes = await Promise.all(
        batch.map((u) => inspectAndVerifyUrl(u, { useBrowser: true }))
      );
      verifications.push(...batchRes);
    }

    rawFinding = replaceRedirectUrlsInText(rawFinding, verifications);

    // Structured extraction of bone summary, decision sub-items, and bone artifacts
    const verificationContext =
      verifications.length > 0
        ? `\nZWERYFIKOWANE LINKI (używaj wyłącznie finalUrl ze statusem ACTIVE_LISTING lub BLOCKED_BY_SITE, odrzuć EXPIRED_OR_NOT_FOUND, OUT_OF_STOCK i SEARCH_OR_CATEGORY_PAGE):\n${JSON.stringify(
            verifications.map((v) => ({
              finalUrl: v.finalUrl,
              status: v.status,
              title: v.title,
              reason: v.reason,
            })),
            null,
            2
          )}`
        : '';

    const extractResponse = await generateWithTimeout(
      `bone-extract-${boneId.slice(0, 8)}`,
      {
        model: config.GEMINI_TRIAGE_MODEL,
        contents: [
          {
            role: 'user',
            parts: [
              {
                text: `Przekształć poniższy wynik pracy AI dla Ości #${bone.position + 1} ("${bone.title}", tryb: ${bone.owner}) w zwięzłe podsumowanie na ość, opcjonalne warianty do wyboru oraz przypięte do tej ości ARTEFAKTY.

WYNIK PRACY AI:
${rawFinding.slice(0, 7000)}
${verificationContext}

ZASADY:
1. "summary": zwięzłe podsumowanie wyniku na tej ości w Markdown (max 5-7 linijek, same konkrety).
2. "artifacts": wyodrębnij konkretne artefakty wypracowane na tej ości:
   - "link": konkretna oferta produktu / strona ze zweryfikowanym URL, ceną (price) i nazwą sklepu (platform). Nie dodawaj stron wyszukiwania ani martwych linków.
   - "message": gotowy do skopiowania tekst wiadomości / pisma / maila.
   - "note": konkretna notatka referencyjna (np. specyfikacja, porównanie parametrów, lista kontrolna).
3. "subItems":
   - Jeśli tryb ości to "shared" (wspólna/decyzyjna), podaj 2-4 krótkie opcje wyboru ("isOption": true), które użytkownik może kliknąć, aby podjąć decyzję na tej ości.
   - Jeśli tryb to "ai", możesz zostawić pustą tablicę (lub 1-2 wykonane kroki).`,
              },
            ],
          },
        ],
        config: {
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              summary: { type: Type.STRING },
              subItems: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    text: { type: Type.STRING },
                    isOption: { type: Type.BOOLEAN },
                  },
                  required: ['text', 'isOption'],
                },
              },
              artifacts: {
                type: Type.ARRAY,
                items: {
                  type: Type.OBJECT,
                  properties: {
                    type: {
                      type: Type.STRING,
                      enum: ['link', 'message', 'note'],
                    },
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
            required: ['summary', 'subItems', 'artifacts'],
          },
        },
      },
      30_000
    );

    const parsed = BoneArtifactsSchema.parse(
      JSON.parse(extractResponse.text ?? '{"summary":"","subItems":[],"artifacts":[]}')
    );

    const verifiedMap = new Map<string, VerifiedUrlInfo>();
    for (const v of verifications) {
      verifiedMap.set(v.originalUrl, v);
      verifiedMap.set(sanitizeUrlPathSlashes(v.originalUrl), v);
      verifiedMap.set(v.finalUrl, v);
      verifiedMap.set(sanitizeUrlPathSlashes(v.finalUrl), v);
    }

    const approvedArtifacts: CreateArtifactInput[] = [];
    for (const a of parsed.artifacts.slice(0, 6)) {
      const meta: Record<string, string> = { boneId };
      if (a.price) meta.price = a.price;
      if (a.platform) meta.platform = a.platform;

      if (a.type !== 'link') {
        if (a.status) meta.status = a.status;
        approvedArtifacts.push({
          type: a.type,
          title: a.title.slice(0, 120),
          content: a.content.slice(0, 4000),
          url: null,
          boneId,
          meta,
          createdBy: 'assistant',
        });
        continue;
      }

      if (!a.url || !a.url.startsWith('http')) continue;
      const cleanUrl = sanitizeUrlPathSlashes(a.url);
      let v = verifiedMap.get(cleanUrl) ?? verifiedMap.get(a.url);
      if (!v) {
        v = await inspectAndVerifyUrl(cleanUrl, { useBrowser: true });
        verifiedMap.set(cleanUrl, v);
      }
      if (
        v.status === 'EXPIRED_OR_NOT_FOUND' ||
        v.status === 'OUT_OF_STOCK' ||
        v.status === 'SEARCH_OR_CATEGORY_PAGE' ||
        v.status === 'ERROR'
      ) {
        continue;
      }

      meta.status =
        v.status === 'ACTIVE_LISTING' ? 'zweryfikowana' : 'sprawdź na portalu';
      approvedArtifacts.push({
        type: 'link',
        title: a.title.slice(0, 120),
        content: a.content.slice(0, 4000),
        url: sanitizeUrlPathSlashes(v.finalUrl),
        boneId,
        meta,
        createdBy: 'assistant',
      });
    }

    if (approvedArtifacts.length > 0) {
      replaceBoneAssistantArtifacts(taskId, boneId, approvedArtifacts);
    }

    const nextSubItems =
      parsed.subItems.length > 0
        ? parsed.subItems.map((s) => ({
            id: crypto.randomUUID(),
            text: s.text,
            completed: bone.owner === 'ai' && !s.isOption,
            isOption: s.isOption,
            selected: false,
          }))
        : bone.subItems.map((s) => ({
            ...s,
            completed: bone.owner === 'ai' && !s.isOption ? true : s.completed,
          }));

    const hasDecisionOptions =
      bone.owner === 'shared' ||
      nextSubItems.some((s) => s.isOption) ||
      (bone.owner !== 'ai' && approvedArtifacts.length > 1);

    const nextStatus: FishboneBoneStatus = hasDecisionOptions
      ? 'needs_user'
      : 'done';

    updateFishboneBone(taskId, boneId, {
      status: nextStatus,
      aiResult: parsed.summary || rawFinding.slice(0, 1500),
      subItems: nextSubItems,
    });

    const finalTask = getTaskDetail(taskId);
    if (finalTask) {
      eventBus.broadcast('task:updated', finalTask.id, finalTask);
      await refreshTaskEmbedOnDiscord(finalTask);

      if (nextStatus === 'needs_user') {
        await postTextToDiscordThread({
          task: finalTask,
          author: 'assistant',
          text: `🦴 **Ość #${bone.position + 1} (${bone.title}) gotowa do Twojej decyzji:**\n\n${parsed.summary || rawFinding.slice(0, 900)}`,
          recordInDb: true,
        });
      }
    }

    return finalTask;
  } catch (err) {
    log.error(
      'FishboneAgent',
      `Błąd wykonywania ości ${boneId} w zadaniu ${taskId}`,
      err
    );
    updateFishboneBone(taskId, boneId, {
      status: 'needs_user',
      aiResult:
        bone.aiResult ||
        '⚠️ Nie udało się ukończyć automatycznej analizy tej ości. Kliknij „Uruchom AI", aby ponowić.',
    });
    const recovered = getTaskDetail(taskId);
    if (recovered) eventBus.broadcast('task:updated', recovered.id, recovered);
    return recovered;
  }
}

export function applyUserActionOnBone(
  taskId: string,
  boneId: string,
  action: {
    selectedArtifactId?: string | null;
    selectSubItemId?: string;
    toggleSubItemId?: string;
    addSubItemText?: string;
    status?: FishboneBoneStatus;
    owner?: FishboneOwner;
    title?: string;
    description?: string;
    aiPrompt?: string | null;
  },
  options?: { autoAdvanceAi?: boolean }
): { task: TaskDetail | null; shouldAdvanceAi: boolean } {
  const task = getTaskDetail(taskId);
  if (!task || !task.fishbone) return { task, shouldAdvanceAi: false };

  const bone = task.fishbone.bones.find((b) => b.id === boneId);
  if (!bone) return { task, shouldAdvanceAi: false };

  let nextSubItems = [...bone.subItems];
  let nextSelectedArtifactId = bone.selectedArtifactId;
  let nextStatus = action.status ?? bone.status;
  let shouldAdvanceAi = false;

  if (action.selectedArtifactId !== undefined) {
    nextSelectedArtifactId = action.selectedArtifactId;
    if (action.selectedArtifactId) {
      nextStatus = 'done';
      shouldAdvanceAi = true;
    }
  }

  if (action.selectSubItemId) {
    nextSubItems = nextSubItems.map((item) => {
      if (item.id === action.selectSubItemId) {
        return { ...item, selected: true, completed: true };
      }
      if (item.isOption) {
        return { ...item, selected: false, completed: false };
      }
      return item;
    });
    nextStatus = 'done';
    shouldAdvanceAi = true;
  }

  if (action.toggleSubItemId) {
    nextSubItems = nextSubItems.map((item) =>
      item.id === action.toggleSubItemId
        ? { ...item, completed: !item.completed, selected: !item.completed }
        : item
    );
    const allCompleted =
      nextSubItems.length > 0 && nextSubItems.every((s) => s.completed);
    if (allCompleted && bone.status !== 'done') {
      nextStatus = 'done';
      shouldAdvanceAi = true;
    }
  }

  if (action.addSubItemText && action.addSubItemText.trim()) {
    nextSubItems.push({
      id: crypto.randomUUID(),
      text: action.addSubItemText.trim(),
      completed: false,
      isOption: false,
      selected: false,
    });
  }

  if (action.status === 'done' && bone.status !== 'done') {
    shouldAdvanceAi = true;
  }

  updateFishboneBone(taskId, boneId, {
    title: action.title,
    description: action.description,
    owner: action.owner,
    aiPrompt: action.aiPrompt,
    status: nextStatus,
    selectedArtifactId: nextSelectedArtifactId,
    subItems: nextSubItems,
  });

  const updated = getTaskDetail(taskId);
  if (updated) {
    eventBus.broadcast('task:updated', updated.id, updated);
    if (shouldAdvanceAi && options?.autoAdvanceAi !== false) {
      void advanceFishboneAiQueue(taskId);
    }
  }

  return { task: updated, shouldAdvanceAi };
}
