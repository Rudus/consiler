import {
  Type,
  type Content,
  type FunctionDeclaration,
  type Part,
} from '@google/genai';
import { config } from '../config.js';
import {
  addChecklistItems,
  addTaskArtifact,
  getTaskDetail,
  toggleChecklistItem,
  updateTask,
} from '../db.js';
import { eventBus } from '../events.js';
import {
  refreshTaskEmbedOnDiscord,
  setDiscordThreadArchived,
} from '../discord/bridge.js';
import type {
  ArtifactType,
  TaskColumn,
  TaskDetail,
  TaskPriority,
} from '../types.js';
import { generateWithTimeout, getGenAI, loadAttachmentsAsParts } from './client.js';
import { buildThreadChatPrompt } from './prompts.js';
import { enqueueBackgroundWork } from './researchWorker.js';
import { prepareCheckoutSession } from './checkoutAgent.js';
import { generateFishboneForTask } from './fishboneAgent.js';
import {
  fetchAndExtractPage,
  inspectAndVerifyUrl,
  sanitizeUrlPathSlashes,
} from './webExtractor.js';
import {
  formatCalendarEventWhenPl,
  listCalendarEvents,
  removeTaskFromCalendar,
  syncTaskToCalendar,
  updateLinkedCalendarEventForTask,
} from '../services/googleCalendar.js';
import { log } from '../logger.js';

const THREAD_TOOLS: FunctionDeclaration[] = [
  {
    name: 'update_task',
    description:
      'Aktualizuje pola bieżącego zadania: tytuł, kolumnę statusu, priorytet, termin wykonania lub czas przypomnienia.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        title: { type: Type.STRING, nullable: true },
        columnStatus: {
          type: Type.STRING,
          enum: ['ai_processing', 'ready_inbox', 'scheduled', 'done'],
          nullable: true,
        },
        priority: {
          type: Type.STRING,
          enum: ['low', 'medium', 'high', 'urgent'],
          nullable: true,
        },
        dueAt: {
          type: Type.STRING,
          description: 'ISO-8601 datetime or empty string to clear',
          nullable: true,
        },
        reminderAt: {
          type: Type.STRING,
          description: 'ISO-8601 datetime or empty string to clear',
          nullable: true,
        },
      },
    },
  },
  {
    name: 'add_checklist_items',
    description: 'Dodaje nowe podzadania do checklisty tego zadania.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        items: {
          type: Type.ARRAY,
          items: { type: Type.STRING },
        },
      },
      required: ['items'],
    },
  },
  {
    name: 'toggle_checklist_item',
    description: 'Oznacza wybrane podzadanie z checklisty jako ukończone lub nieukończone.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        itemId: { type: Type.STRING },
        completed: { type: Type.BOOLEAN },
      },
      required: ['itemId', 'completed'],
    },
  },
  {
    name: 'run_followup_research',
    description:
      'Uruchamia w tle pogłębiony research w internecie lub przygotowanie zaktualizowanego szkicu/raportu według nowej wskazówki użytkownika.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        instruction: {
          type: Type.STRING,
          description: 'Dokładne polecenie dla agenta pracującego w tle.',
        },
      },
      required: ['instruction'],
    },
  },
  {
    name: 'fetch_webpage',
    description:
      'Pobiera i odczytuje zawartość tekstową konkretnego adresu URL podanego przez użytkownika.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: { type: Type.STRING },
      },
      required: ['url'],
    },
  },
  {
    name: 'save_artifact',
    description:
      'Zapisuje gotowy artefakt w dedykowanej sekcji Artefakty na tablicy (np. gotową wiadomość do skopiowania, konkretny link do oferty lub notatkę referencyjną).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        type: { type: Type.STRING, enum: ['link', 'message', 'note'] },
        title: { type: Type.STRING },
        content: {
          type: Type.STRING,
          description: 'Czysta treść wiadomości do skopiowania lub krótki opis oferty/notatki.',
        },
        url: { type: Type.STRING, nullable: true },
        price: { type: Type.STRING, nullable: true },
        platform: { type: Type.STRING, nullable: true },
        boneId: {
          type: Type.STRING,
          description: 'Opcjonalne ID ości (fishbone bone), do której przypiąć artefakt.',
          nullable: true,
        },
      },
      required: ['type', 'title', 'content'],
    },
  },
  {
    name: 'generate_fishbone',
    description:
      'Rozbija bieżące zadanie/problem na hybrydowy Graf Rybiej Ości (Fishbone / Anti-Paralysis) z etapami dla AI i użytkownika oraz uruchamia pracę AI na pierwszych ościach.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        customHint: {
          type: Type.STRING,
          description: 'Opcjonalna wskazówka jak podzielić etapy problemu.',
          nullable: true,
        },
        pinAsBigThing: {
          type: Type.BOOLEAN,
          description: 'Czy przypiąć jako główne zadanie dnia (One Big Thing).',
          nullable: true,
        },
      },
    },
  },
  {
    name: 'prepare_checkout',
    description:
      'Uruchamia agenta przygotowania zakupu (Faza 1.5): dodaje produkt z wybranego artefaktu/URL do koszyka, wypełnia formularz dostawy i zatrzymuje się przed płatnością, wysyłając screena do przejęcia przez użytkownika.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        artifactId: { type: Type.STRING, nullable: true },
        productUrl: { type: Type.STRING, nullable: true },
        variantHint: {
          type: Type.STRING,
          description: 'Opcjonalny preferowany kolor/rozmiar/wariant.',
          nullable: true,
        },
      },
    },
  },
  {
    name: 'add_task_to_calendar',
    description:
      'Dodaje bieżące zadanie do Google Calendar „Dom” (lub aktualizuje powiązane wydarzenie). Wywołuj TYLKO gdy użytkownik wyraźnie poprosi w wątku o dodanie/zmianę w kalendarzu.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        start: {
          type: Type.STRING,
          description: 'Opcjonalna data/godzina startu (ISO-8601 lub YYYY-MM-DD); jeśli brak, użyje terminu zadania.',
          nullable: true,
        },
        end: { type: Type.STRING, nullable: true },
        allDay: { type: Type.BOOLEAN, nullable: true },
        title: { type: Type.STRING, nullable: true },
        location: { type: Type.STRING, nullable: true },
        description: { type: Type.STRING, nullable: true },
        reminderMinutes: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          nullable: true,
        },
      },
    },
  },
  {
    name: 'remove_task_from_calendar',
    description:
      'Usuwa powiązane wydarzenie tego zadania z Google Calendar „Dom” (zadanie zostaje na tablicy).',
    parameters: {
      type: Type.OBJECT,
      properties: {},
    },
  },
  {
    name: 'list_calendar_events',
    description:
      'Odczytuje wydarzenia z Google Calendar „Dom” w podanym zakresie czasu (np. do sprawdzenia kolizji lub wolnych terminów).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        fromIso: { type: Type.STRING },
        toIso: { type: Type.STRING },
      },
      required: ['fromIso', 'toIso'],
    },
  },
];

function normalizeOptionalIso(val: unknown): string | null | undefined {
  if (val === undefined || val === null) return undefined;
  if (typeof val !== 'string') return undefined;
  if (val.trim() === '') return null;
  const d = new Date(val);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

export async function runThreadAssistantTurn(
  taskId: string,
  latestUserMessage: string
): Promise<{ reply: string; triggeredBackgroundResearch: boolean }> {
  let task = getTaskDetail(taskId);
  if (!task) {
    return { reply: 'Nie znaleziono zadania.', triggeredBackgroundResearch: false };
  }

  const ai = getGenAI();
  if (!ai) {
    return {
      reply:
        'Wiadomość zapisana w historii zadania. (Tryb AI jest wyłączony — brak GEMINI_API_KEY).',
      triggeredBackgroundResearch: false,
    };
  }

  const nowIso = new Date().toISOString();
  const imageParts = await loadAttachmentsAsParts(task.attachments);

  const checklistSnapshot =
    task.checklist.length > 0
      ? task.checklist
          .map(
            (c) =>
              `- [${c.completed ? 'x' : ' '}] (id: ${c.id}) ${c.text}`
          )
          .join('\n')
      : '(brak podzadań)';

  const artifactsSnapshot =
    task.artifacts.length > 0
      ? task.artifacts
          .map(
            (a) =>
              `- [${a.type}] (id: ${a.id}${a.boneId ? `, boneId: ${a.boneId}` : ''}) ${a.title}${a.url ? ` -> ${a.url}` : ''}${a.meta?.price ? ` (${a.meta.price})` : ''}`
          )
          .join('\n')
      : '(brak artefaktów)';

  const fishboneSnapshot = task.fishbone
    ? [
        `Głowa: ${task.fishbone.headGoal} | Ogon: ${task.fishbone.tailOutcome}`,
        ...task.fishbone.bones.map(
          (b, i) =>
            `  ${i + 1}. (boneId: ${b.id}) [${b.owner.toUpperCase()} / ${b.status}] ${b.title}${b.aiResult ? ` — ${b.aiResult.slice(0, 160)}` : ''}`
        ),
      ].join('\n')
    : '(brak rozpisanej rybiej ości)';

  const taskContext = [
    `KONTEKST BIEŻĄCEGO ZADANIA (ID: ${task.id}):`,
    `Tytuł: ${task.title}`,
    `Kolumna: ${task.columnStatus} | Priorytet: ${task.priority} | Kategoria: ${task.category}`,
    `Termin (dueAt): ${task.dueAt ?? 'brak'}`,
    `Przypomnienie (reminderAt): ${task.reminderAt ?? 'brak'}`,
    `Kalendarz „${config.GOOGLE_CALENDAR_NAME}”: ${
      task.googleEventId
        ? `DODANE (eventId: ${task.googleEventId}, kiedy: ${formatCalendarEventWhenPl(task.googleEventStart, task.googleEventEnd, task.googleEventAllDay, config.TIMEZONE)}${task.googleEventLocation ? `, miejsce: ${task.googleEventLocation}` : ''})`
        : 'nie dodane'
    } | status połączenia: ${config.calendarEnabled ? 'POŁĄCZONY' : 'WYŁĄCZONY'}`,
    `Podsumowanie AI: ${task.aiSummary}`,
    task.researchReport
      ? `Aktualny raport researchu/szkicu:\n${task.researchReport.slice(0, 4000)}`
      : 'Aktualny raport: brak',
    `Checklista:\n${checklistSnapshot}`,
    `Rybia Ość (Fishbone):\n${fishboneSnapshot}`,
    `Artefakty:\n${artifactsSnapshot}`,
  ].join('\n');

  // Recent conversation history (excluding the very last user message if already saved)
  const historyLines = task.messages
    .slice(-14)
    .map((m) => `[${m.author.toUpperCase()} via ${m.source}]: ${m.content}`)
    .join('\n');

  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        ...imageParts,
        {
          text: `${taskContext}\n\nHISTORIA ROZMOWY:\n${historyLines || '(brak wcześniejszych wiadomości)'}\n\nNOWA WIADOMOŚĆ UŻYTKOWNIKA:\n${latestUserMessage}`,
        },
      ],
    },
  ];

  let triggeredBackgroundResearch = false;

  try {
    for (let step = 0; step < 3; step++) {
      const response = await generateWithTimeout(
        `thread-chat-${taskId.slice(0, 8)}-s${step + 1}`,
        {
          model: config.GEMINI_TRIAGE_MODEL,
          contents,
          config: {
            systemInstruction: buildThreadChatPrompt(
              nowIso,
              config.TIMEZONE,
              config.GOOGLE_CALENDAR_NAME
            ),
            tools: [{ functionDeclarations: THREAD_TOOLS }],
          },
        },
        45_000
      );

      const fnCalls = response.functionCalls;
      if (!fnCalls || fnCalls.length === 0) {
        const text = response.text?.trim();
        return {
          reply: text || 'Gotowe — zaktualizowano zadanie.',
          triggeredBackgroundResearch,
        };
      }

      const modelParts = response.candidates?.[0]?.content?.parts ?? [];
      contents.push({ role: 'model', parts: modelParts });

      const responseParts: Part[] = [];

      for (const call of fnCalls) {
        const name = call.name ?? '';
        const args = (call.args ?? {}) as Record<string, unknown>;
        log.info('ThreadChat', `Tool call: ${name}`, args);
        let toolResult: Record<string, unknown> = { ok: true };

        if (name === 'update_task') {
          const prevTitle = task.title;
          const prevDueAt = task.dueAt;
          const patch: Parameters<typeof updateTask>[1] = {};
          if (typeof args.title === 'string' && args.title.trim()) {
            patch.title = args.title.trim().slice(0, 120);
          }
          if (typeof args.columnStatus === 'string') {
            patch.columnStatus = args.columnStatus as TaskColumn;
          }
          if (typeof args.priority === 'string') {
            patch.priority = args.priority as TaskPriority;
          }
          const dueAt = normalizeOptionalIso(args.dueAt);
          if (dueAt !== undefined) patch.dueAt = dueAt;
          const reminderAt = normalizeOptionalIso(args.reminderAt);
          if (reminderAt !== undefined) {
            patch.reminderAt = reminderAt;
            patch.reminderSentAt = null;
          }

          const updated = updateTask(taskId, patch);
          if (updated) {
            task = updated;
            eventBus.broadcast('task:updated', updated.id, updated);
            await refreshTaskEmbedOnDiscord(updated);
            if (patch.columnStatus === 'done') {
              await setDiscordThreadArchived(updated.discordThreadId, true);
            } else if (patch.columnStatus !== undefined) {
              await setDiscordThreadArchived(updated.discordThreadId, false);
            }

            const titleChanged = updated.title !== prevTitle;
            const dueAtChanged = Boolean(
              updated.dueAt && updated.dueAt !== prevDueAt
            );
            if (updated.googleEventId && (titleChanged || dueAtChanged)) {
              await updateLinkedCalendarEventForTask(updated, {
                titleChanged,
                dueAtChanged,
              });
              task = getTaskDetail(taskId) ?? updated;
            }
          }
          toolResult = {
            ok: true,
            columnStatus: task.columnStatus,
            dueAt: task.dueAt,
            reminderAt: task.reminderAt,
          };
        } else if (name === 'add_checklist_items') {
          const items = Array.isArray(args.items)
            ? args.items.filter((x): x is string => typeof x === 'string')
            : [];
          const added = addChecklistItems(taskId, items);
          const refreshed = getTaskDetail(taskId);
          if (refreshed) {
            task = refreshed;
            eventBus.broadcast('task:updated', refreshed.id, refreshed);
            await refreshTaskEmbedOnDiscord(refreshed);
          }
          toolResult = { ok: true, addedCount: added.length };
        } else if (name === 'toggle_checklist_item') {
          const itemId = String(args.itemId ?? '');
          const completed = Boolean(args.completed);
          const toggled = toggleChecklistItem(taskId, itemId, completed);
          const refreshed = getTaskDetail(taskId);
          if (refreshed) {
            task = refreshed;
            eventBus.broadcast('task:updated', refreshed.id, refreshed);
          }
          toolResult = { ok: Boolean(toggled) };
        } else if (name === 'run_followup_research') {
          const instruction = String(args.instruction ?? latestUserMessage);
          triggeredBackgroundResearch = true;
          enqueueBackgroundWork(taskId, instruction);
          toolResult = {
            ok: true,
            queued: true,
            message: 'Research queued in background.',
          };
        } else if (name === 'fetch_webpage') {
          const url = String(args.url ?? '');
          try {
            const page = await fetchAndExtractPage(url);
            toolResult = {
              ok: true,
              title: page.title,
              url: page.url,
              text: page.text.slice(0, 5000),
            };
          } catch (err) {
            toolResult = {
              ok: false,
              error: err instanceof Error ? err.message : 'Fetch error',
            };
          }
        } else if (name === 'save_artifact') {
          const type = (['link', 'message', 'note'].includes(String(args.type))
            ? String(args.type)
            : 'note') as ArtifactType;
          const title = String(args.title ?? '').trim() || 'Artefakt';
          const content = String(args.content ?? '').trim();
          let url =
            typeof args.url === 'string' && args.url.trim()
              ? sanitizeUrlPathSlashes(args.url.trim())
              : null;
          const meta: Record<string, string> = {};
          if (typeof args.price === 'string' && args.price.trim()) {
            meta.price = args.price.trim();
          }
          if (typeof args.platform === 'string' && args.platform.trim()) {
            meta.platform = args.platform.trim();
          }

          let rejectedReason: string | null = null;
          if (type === 'link') {
            if (!url) {
              rejectedReason = 'Artefakt typu link musi zawierać poprawny URL.';
            } else {
              const check = await inspectAndVerifyUrl(url, { useBrowser: true });
              log.info('ArtifactGate', `save_artifact: ${check.finalUrl} -> ${check.status}`, {
                by: check.verifiedBy,
                reason: check.reason,
              });

              if (
                check.status === 'EXPIRED_OR_NOT_FOUND' ||
                check.status === 'OUT_OF_STOCK' ||
                check.status === 'SEARCH_OR_CATEGORY_PAGE' ||
                check.status === 'ERROR'
              ) {
                rejectedReason = `Odrzucono link (${check.status}): ${check.reason}`;
              } else {
                url = check.finalUrl;
                meta.status =
                  check.status === 'ACTIVE_LISTING'
                    ? check.verifiedBy === 'playwright'
                      ? 'zweryfikowana (Chromium)'
                      : 'zweryfikowana'
                    : 'sprawdź na portalu (blokada bota)';
              }
            }
          }

          if (rejectedReason) {
            toolResult = {
              ok: false,
              rejected: true,
              reason: rejectedReason,
              instruction:
                'NIE zapisano artefaktu, ponieważ link nie przeszedł bramki jakości. NIE zgaduj innych URL-i — wywołaj run_followup_research aby znaleźć i zweryfikować prawdziwe oferty.',
            };
          } else {
            const boneId =
              typeof args.boneId === 'string' && args.boneId.trim()
                ? args.boneId.trim()
                : null;
            const created = addTaskArtifact(taskId, {
              type,
              title,
              content,
              url,
              boneId,
              meta,
              createdBy: 'assistant',
            });
            const refreshed = getTaskDetail(taskId);
            if (refreshed) {
              task = refreshed;
              eventBus.broadcast('task:updated', refreshed.id, refreshed);
            }
            toolResult = {
              ok: true,
              artifactId: created.id,
              title: created.title,
              verifiedUrl: url,
              boneId,
            };
          }
        } else if (name === 'generate_fishbone') {
          const customHint =
            typeof args.customHint === 'string' && args.customHint.trim()
              ? args.customHint.trim()
              : undefined;
          const pinAsBigThing =
            typeof args.pinAsBigThing === 'boolean'
              ? args.pinAsBigThing
              : undefined;
          const generated = await generateFishboneForTask(taskId, {
            customHint,
            pinAsBigThing,
            autoAdvanceAi: true,
          });
          if (generated) {
            task = generated;
          }
          toolResult = {
            ok: Boolean(generated?.fishbone),
            bonesCount: generated?.fishbone?.bones.length ?? 0,
            headGoal: generated?.fishbone?.headGoal ?? task.title,
          };
        } else if (name === 'prepare_checkout') {
          let artifactId =
            typeof args.artifactId === 'string' && args.artifactId.trim()
              ? args.artifactId.trim()
              : null;
          let productUrl =
            typeof args.productUrl === 'string' && args.productUrl.trim()
              ? sanitizeUrlPathSlashes(args.productUrl.trim())
              : '';
          if (!productUrl && artifactId) {
            const art = task.artifacts.find((a) => a.id === artifactId);
            if (art?.url) productUrl = sanitizeUrlPathSlashes(art.url);
          }
          if (!productUrl) {
            const firstLink = task.artifacts.find((a) => a.type === 'link' && a.url);
            if (firstLink?.url) {
              productUrl = sanitizeUrlPathSlashes(firstLink.url);
              if (!artifactId) artifactId = firstLink.id;
            }
          }
          if (!artifactId && productUrl) {
            const matchedArt = task.artifacts.find(
              (a) => a.url && sanitizeUrlPathSlashes(a.url) === productUrl
            );
            if (matchedArt) artifactId = matchedArt.id;
          }

          if (!productUrl) {
            toolResult = { ok: false, error: 'Brak adresu URL produktu do zakupu.' };
          } else {
            try {
              const session = await prepareCheckoutSession({
                taskId: task.id,
                artifactId,
                productUrl,
                variantHint:
                  typeof args.variantHint === 'string' ? args.variantHint : undefined,
              });
              toolResult = {
                ok: true,
                sessionId: session.id,
                shopDomain: session.shopDomain,
                message: 'Sesja przygotowania koszyka uruchomiona w tle.',
              };
            } catch (err) {
              toolResult = {
                ok: false,
                error:
                  err instanceof Error
                    ? err.message
                    : 'Nie udało się uruchomić przygotowania zakupu.',
              };
            }
          }
        } else if (name === 'add_task_to_calendar') {
          if (!config.calendarEnabled) {
            toolResult = {
              ok: false,
              error: 'Kalendarz Google nie jest jeszcze skonfigurowany w .env.',
            };
          } else {
            try {
              const reminderMinutes = Array.isArray(args.reminderMinutes)
                ? args.reminderMinutes.filter((m): m is number => typeof m === 'number')
                : undefined;
              const synced = await syncTaskToCalendar(taskId, {
                start: typeof args.start === 'string' ? args.start : undefined,
                end: typeof args.end === 'string' ? args.end : undefined,
                allDay:
                  typeof args.allDay === 'boolean' ? args.allDay : undefined,
                title: typeof args.title === 'string' ? args.title : undefined,
                location:
                  typeof args.location === 'string' ? args.location : undefined,
                description:
                  typeof args.description === 'string'
                    ? args.description
                    : undefined,
                reminderMinutes,
                autoAdded: false,
              });
              task = synced.task;
              toolResult = {
                ok: true,
                eventId: synced.event.id,
                htmlLink: synced.event.htmlLink,
                when: formatCalendarEventWhenPl(
                  synced.event.start,
                  synced.event.end,
                  synced.event.allDay,
                  config.TIMEZONE
                ),
              };
            } catch (err) {
              toolResult = {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        } else if (name === 'remove_task_from_calendar') {
          try {
            const res = await removeTaskFromCalendar(taskId);
            task = res.task;
            toolResult = { ok: true, removed: res.removed };
          } catch (err) {
            toolResult = {
              ok: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        } else if (name === 'list_calendar_events') {
          if (!config.calendarEnabled) {
            toolResult = {
              ok: false,
              error: 'Kalendarz Google nie jest jeszcze skonfigurowany w .env.',
            };
          } else {
            try {
              const events = await listCalendarEvents({
                timeMin: String(args.fromIso ?? ''),
                timeMax: String(args.toIso ?? ''),
              });
              toolResult = {
                ok: true,
                calendarName: config.GOOGLE_CALENDAR_NAME,
                count: events.length,
                events,
              };
            } catch (err) {
              toolResult = {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        }

        responseParts.push({
          functionResponse: {
            name,
            response: toolResult,
          },
        });
      }

      contents.push({ role: 'user', parts: responseParts });
    }

    return {
      reply: 'Zaktualizowałem zadanie zgodnie z ustaleniami.',
      triggeredBackgroundResearch,
    };
  } catch (err) {
    log.error('ThreadChat', `Błąd konwersacji dla ${taskId}`, err);
    return {
      reply:
        '⚠️ Nie udało się przetworzyć wiadomości przez AI (błąd API), ale zapisałem ją w historii zadania.',
      triggeredBackgroundResearch,
    };
  }
}
