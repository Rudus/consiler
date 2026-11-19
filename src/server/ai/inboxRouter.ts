import { Type, type Content, type FunctionDeclaration, type Part } from '@google/genai';
import { z } from 'zod';
import { config } from '../config.js';
import {
  getTaskByGoogleEventId,
  getTaskDetail,
  listTasks,
  updateTask,
} from '../db.js';
import { eventBus } from '../events.js';
import { log } from '../logger.js';
import {
  postTextToDiscordThread,
  refreshTaskEmbedOnDiscord,
  setDiscordThreadArchived,
} from '../discord/bridge.js';
import { formatDatePl } from '../discord/formatting.js';
import {
  createCalendarEvent,
  deleteCalendarEvent,
  listCalendarEvents,
  localDateTimeToIso,
  removeTaskFromCalendar,
  shouldAutoSyncTriageToCalendar,
  syncTaskToCalendar,
  updateCalendarEvent,
  updateLinkedCalendarEventForTask,
} from '../services/googleCalendar.js';
import type { TaskColumn } from '../types.js';
import { generateWithTimeout, getGenAI } from './client.js';
import { enqueueBackgroundWork } from './researchWorker.js';
import { runTriage } from './triage.js';

export type InboxIntent = 'CREATE_TASK' | 'BOARD_QUERY';

const IntentSchema = z.object({
  intent: z.enum(['CREATE_TASK', 'BOARD_QUERY']),
  reasoning: z.string(),
});

export async function classifyInboxIntent(
  userText: string,
  hasAttachments: boolean
): Promise<{ intent: InboxIntent; reasoning: string }> {
  if (hasAttachments) {
    return {
      intent: 'CREATE_TASK',
      reasoning: 'Wiadomość zawiera załącznik graficzny (screen).',
    };
  }

  const trimmed = userText.trim();
  if (!trimmed) {
    return { intent: 'CREATE_TASK', reasoning: 'Pusta treść.' };
  }

  const ai = getGenAI();
  if (!ai) {
    return { intent: 'CREATE_TASK', reasoning: 'Tryb offline AI.' };
  }

  try {
    const response = await generateWithTimeout(
      'inbox-intent',
      {
        model: config.GEMINI_TRIAGE_MODEL,
        contents: [{ role: 'user', parts: [{ text: trimmed }] }],
        config: {
          systemInstruction: `Jesteś klasyfikatorem intencji dla kanału #inbox osobistego asystenta zadań (Consiler).
Twoim jedynym zadaniem jest zdecydować, czy wiadomość użytkownika (bez załączonego obrazka) to:
1. "BOARD_QUERY" — pytanie o istniejące zadania na tablicy, kalendarz „${config.GOOGLE_CALENDAR_NAME}”, plany na dzień/tydzień/miesiąc, wolne terminy, przypomnienia, podsumowanie dnia/tygodnia, prośba o zmianę/zamknięcie/ponowny triage/research/dodanie do kalendarza istniejącego zadania, prośba o edycję/przesunięcie/usunięcie istniejącego wydarzenia z kalendarza (także dodanego ręcznie poza Consilerem), lub pytanie do asystenta o jego działanie.
Przykłady BOARD_QUERY:
- "jakie mamy zadania na jutro?"
- "co mamy w kalendarzu w tym tygodniu?" / "kiedy mamy wolne w sobotę?"
- "przenieś wizytę u dentysty z kalendarza na piątek na 17:00"
- "usuń z kalendarza spotkanie w środę"
- "wrzuć zadanie ze słuchawkami do kalendarza na jutro o 18:00"
- "co mam dziś do zrobienia?" / "pokaż zaległe zadania" / "co wisi w inboxie?"
- "oznacz zadanie ze słuchawkami jako zrobione"
- "przeanalizuj jeszcze raz zadanie z Mateuszem" / "zrób ponowny triage zadania X"

2. "CREATE_TASK" — dodanie nowego zadania, rzeczy do zrobienia, przypomnienia do ustawienia, linku do sprawdzenia, tematu do researchu, szkicu do napisania, albo nowego konkretnego wydarzenia z datą do zapisania jako zadanie (i ewentualnie do kalendarza).
Przykłady CREATE_TASK:
- "kupić mleko i kawę jutro"
- "przypomnij w piątek o 14:00 opłacić fakturę"
- "dodaj do kalendarza wizytę u weta w piątek o 16:00"
- "sprawdź ile kosztuje nowy Kindle i czy warto"
- "napisać maila do księgowej w sprawie PIT"

Zasada ostrożności: jeśli wiadomość to pytanie o stan tablicy/kalendarza/agendy albo odwołuje się do już istniejącego zadania na tablicy lub istniejącego wydarzenia w kalendarzu do sprawdzenia/zmiany/usunięcia -> wybierz "BOARD_QUERY".`,
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              intent: {
                type: Type.STRING,
                enum: ['CREATE_TASK', 'BOARD_QUERY'],
              },
              reasoning: { type: Type.STRING },
            },
            required: ['intent', 'reasoning'],
          },
        },
      },
      25_000
    );

    const parsed = IntentSchema.parse(JSON.parse(response.text ?? '{}'));
    return parsed;
  } catch (err) {
    log.error('InboxRouter', 'Błąd klasyfikacji intencji', err);
    return {
      intent: 'CREATE_TASK',
      reasoning: 'Fallback przy błędzie klasyfikacji.',
    };
  }
}

const BOARD_QUERY_TOOLS: FunctionDeclaration[] = [
  {
    name: 'update_existing_task',
    description:
      'Aktualizuje status (kolumnę) lub termin/przypomnienie istniejącego zadania wskazanego po ID.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: { type: Type.STRING },
        columnStatus: {
          type: Type.STRING,
          enum: ['ai_processing', 'ready_inbox', 'scheduled', 'done'],
          nullable: true,
        },
        dueAt: { type: Type.STRING, nullable: true },
        reminderAt: { type: Type.STRING, nullable: true },
      },
      required: ['taskId'],
    },
  },
  {
    name: 're_triage_task',
    description:
      'Ponownie uruchamia analizę (triage) istniejącego zadania wraz z jego oryginalnym screenem i opcjonalną nową wskazówką użytkownika (aktualizuje tytuł, podsumowanie, rozumowanie, termin, przypomnienie i ewentualnie pracę w tle).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: { type: Type.STRING },
        extraInstruction: {
          type: Type.STRING,
          description: 'Dodatkowa wskazówka od użytkownika, co uwzględnić przy ponownym triage.',
          nullable: true,
        },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'rerun_task_research',
    description:
      'Uruchamia w tle pogłębiony research lub przygotowanie szkicu/planu dla istniejącego zadania.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: { type: Type.STRING },
        instruction: { type: Type.STRING, nullable: true },
      },
      required: ['taskId'],
    },
  },
  {
    name: 'list_calendar_events',
    description:
      'Odczytuje wydarzenia z Google Calendar „Dom” w zadanym zakresie czasu (w tym wydarzenia dodane ręcznie przez domowników).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        fromIso: {
          type: Type.STRING,
          description: 'Początek zakresu w ISO-8601 z offsetem (np. 2026-11-19T00:00:00+01:00).',
        },
        toIso: {
          type: Type.STRING,
          description: 'Koniec zakresu w ISO-8601 z offsetem (np. 2026-11-26T23:59:59+01:00).',
        },
        query: {
          type: Type.STRING,
          description: 'Opcjonalna fraza filtrująca po tytule/opisie/miejscu.',
          nullable: true,
        },
      },
      required: ['fromIso', 'toIso'],
    },
  },
  {
    name: 'create_calendar_event',
    description:
      'Tworzy nowe wydarzenie w Google Calendar „Dom”. Jeśli dotyczy zadania z tablicy, przekaż też taskId.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        summary: { type: Type.STRING },
        start: {
          type: Type.STRING,
          description: 'ISO-8601 z offsetem lub YYYY-MM-DD dla wydarzenia całodniowego.',
        },
        end: { type: Type.STRING, nullable: true },
        allDay: { type: Type.BOOLEAN, nullable: true },
        description: { type: Type.STRING, nullable: true },
        location: { type: Type.STRING, nullable: true },
        reminderMinutes: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          nullable: true,
        },
        taskId: { type: Type.STRING, nullable: true },
      },
      required: ['summary', 'start'],
    },
  },
  {
    name: 'update_calendar_event',
    description:
      'Edytuje istniejące wydarzenie w Google Calendar „Dom” wskazane po eventId (np. zmiana godziny, dnia, tytułu, miejsca). Najpierw pobierz eventId przez list_calendar_events.',
    parameters: {
      type: Type.OBJECT,
      properties: {
        eventId: { type: Type.STRING },
        summary: { type: Type.STRING, nullable: true },
        start: { type: Type.STRING, nullable: true },
        end: { type: Type.STRING, nullable: true },
        allDay: { type: Type.BOOLEAN, nullable: true },
        description: { type: Type.STRING, nullable: true },
        location: { type: Type.STRING, nullable: true },
        reminderMinutes: {
          type: Type.ARRAY,
          items: { type: Type.INTEGER },
          nullable: true,
        },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'delete_calendar_event',
    description:
      'Usuwa wydarzenie z Google Calendar „Dom” wskazane po eventId (nie usuwa ewentualnego powiązanego zadania z tablicy).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        eventId: { type: Type.STRING },
      },
      required: ['eventId'],
    },
  },
  {
    name: 'sync_task_to_calendar',
    description:
      'Dodaje istniejące zadanie z tablicy Consiler do Google Calendar „Dom” (lub aktualizuje powiązane wydarzenie).',
    parameters: {
      type: Type.OBJECT,
      properties: {
        taskId: { type: Type.STRING },
        start: { type: Type.STRING, nullable: true },
        end: { type: Type.STRING, nullable: true },
        allDay: { type: Type.BOOLEAN, nullable: true },
        location: { type: Type.STRING, nullable: true },
      },
      required: ['taskId'],
    },
  },
];

function formatLocalDayInfo(iso: string | null, timezone: string): string {
  if (!iso) return 'brak';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const local = new Intl.DateTimeFormat('pl-PL', {
    timeZone: timezone,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
  return `${local} (${iso})`;
}

export async function answerBoardQuery(userQuery: string): Promise<string> {
  const ai = getGenAI();
  const tasks = listTasks();
  log.info('InboxRouter', `Start answerBoardQuery (zadań w bazie: ${tasks.length})`, {
    query: userQuery.slice(0, 120),
  });

  const now = new Date();
  const nowLocal = new Intl.DateTimeFormat('pl-PL', {
    timeZone: config.TIMEZONE,
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(now);

  if (!ai) {
    const active = tasks.filter((t) => t.columnStatus !== 'done');
    if (active.length === 0) return 'Tablica jest pusta — nie masz aktywnych zadań.';
    return (
      `📋 **Aktywne zadania (${active.length}):**\n` +
      active
        .slice(0, 10)
        .map(
          (t) =>
            `• **${t.title}** (${t.columnStatus})${t.dueAt ? ` — termin: ${formatDatePl(t.dueAt)}` : ''}`
        )
        .join('\n')
    );
  }

  const snapshot = tasks.slice(0, 60).map((t) => ({
    id: t.id,
    title: t.title,
    userPrompt: t.userPrompt.slice(0, 160),
    columnStatus: t.columnStatus,
    priority: t.priority,
    category: t.category,
    dueAtLocal: formatLocalDayInfo(t.dueAt, config.TIMEZONE),
    reminderAtLocal: formatLocalDayInfo(t.reminderAt, config.TIMEZONE),
    inCalendar: Boolean(t.googleEventId),
    googleEventId: t.googleEventId,
    hasAttachments: t.attachments.length,
    hasResearchReport: Boolean(t.researchReport),
    summary: t.aiSummary.slice(0, 180),
    url: `${config.APP_BASE_URL}/?task=${t.id}`,
  }));

  const contents: Content[] = [
    {
      role: 'user',
      parts: [
        {
          text: `AKTUALNY CZAS LOKALNY: ${nowLocal} (${now.toISOString()}, strefa: ${config.TIMEZONE})\nSTATUS KALENDARZA „${config.GOOGLE_CALENDAR_NAME}”: ${config.calendarEnabled ? 'POŁĄCZONY' : 'NIE SKONFIGUROWANY'}\n\nAKTUALNA ZAWARTOŚĆ TABLICY ZADAŃ (JSON):\n${JSON.stringify(snapshot, null, 2)}\n\nZAPYTANIE UŻYTKOWNIKA NA #inbox:\n"${userQuery}"`,
        },
      ],
    },
  ];

  try {
    for (let step = 0; step < 5; step++) {
      const response = await generateWithTimeout(
        `inbox-query-step-${step + 1}`,
        {
          model: config.GEMINI_TRIAGE_MODEL,
          contents,
          config: {
            systemInstruction: `Jesteś asystentem zadań Consiler odpowiadającym bezpośrednio na pytanie lub polecenie użytkownika na kanale #inbox (Discord).
ZASADY:
1. Analizuj daty DOKŁADNIE względem podanego AKTUALNEGO CZASU LOKALNEGO i strefy ${config.TIMEZONE}.
2. Jeśli użytkownik pyta o kalendarz „${config.GOOGLE_CALENDAR_NAME}”, plany na konkretny dzień/tydzień/miesiąc, wolne terminy albo wydarzenia — OBOWIĄZKOWO wywołaj \`list_calendar_events\` dla odpowiedniego zakresu dat (aby zobaczyć również wydarzenia wpisane ręcznie przez domowników!).
3. Jeśli użytkownik pyta o zadania na konkretny dzień (np. "na jutro", "na dziś"), wymień przede wszystkim zadania z dueAtLocal lub reminderAtLocal przypadającym na ten dzień (pomijaj zadania ze statusem "done", chyba że użytkownik pyta o ukończone), a jeśli kalendarz jest połączony, połącz to z wynikami z \`list_calendar_events\`.
4. Jeśli użytkownik prosi o edycję, przesunięcie lub usunięcie wydarzenia z kalendarza — najpierw wywołaj \`list_calendar_events\`, żeby zdobyć dokładny \`eventId\`, a potem wywołaj \`update_calendar_event\` lub \`delete_calendar_event\`.
5. Jeśli użytkownik prosi o dodanie istniejącego zadania z tablicy do kalendarza — wywołaj \`sync_task_to_calendar\`.
6. Jeśli użytkownik prosi o ponowny triage / ponowną analizę istniejącego zadania — znajdź je w JSON i OBOWIĄZKOWO wywołaj narzędzie re_triage_task.
7. Jeśli użytkownik prosi o ponowny research — wywołaj rerun_task_research.
8. Jeśli prosi o zmianę statusu, zamknięcie lub przesunięcie terminu zadania — wywołaj update_existing_task.
9. Przy każdym wymienionym zadaniu możesz dodać link w formacie Markdown [Otwórz](url). Odpowiadaj zwięźle i konkretnie po polsku.`,
            tools: [{ functionDeclarations: BOARD_QUERY_TOOLS }],
          },
        },
        45_000
      );

      const fnCalls = response.functionCalls;
      if (!fnCalls || fnCalls.length === 0) {
        const text =
          response.text?.trim() ||
          'Nie znalazłem pasujących informacji na tablicy.';
        log.info('InboxRouter', 'Odpowiedź gotowa', { chars: text.length });
        return text;
      }

      const modelParts = response.candidates?.[0]?.content?.parts ?? [];
      contents.push({ role: 'model', parts: modelParts });

      const responseParts: Part[] = [];
      for (const call of fnCalls) {
        const name = call.name ?? '';
        const args = (call.args ?? {}) as Record<string, unknown>;
        log.info('InboxRouter', `Tool call: ${name}`, args);
        let toolResult: Record<string, unknown> = { ok: false };

        if (name === 'update_existing_task' && typeof args.taskId === 'string') {
          const prev = getTaskDetail(args.taskId);
          const patch: Parameters<typeof updateTask>[1] = {};
          if (typeof args.columnStatus === 'string') {
            patch.columnStatus = args.columnStatus as TaskColumn;
          }
          if (typeof args.dueAt === 'string') patch.dueAt = args.dueAt;
          if (typeof args.reminderAt === 'string') {
            patch.reminderAt = args.reminderAt;
            patch.reminderSentAt = null;
          }
          const updated = updateTask(args.taskId, patch);
          if (updated) {
            eventBus.broadcast('task:updated', updated.id, updated);
            await refreshTaskEmbedOnDiscord(updated);
            if (patch.columnStatus === 'done') {
              await setDiscordThreadArchived(updated.discordThreadId, true);
            }
            if (
              updated.googleEventId &&
              typeof patch.dueAt === 'string' &&
              patch.dueAt !== prev?.dueAt
            ) {
              await updateLinkedCalendarEventForTask(updated, {
                dueAtChanged: true,
              });
            }
            toolResult = {
              ok: true,
              title: updated.title,
              columnStatus: updated.columnStatus,
            };
          } else {
            toolResult = { ok: false, error: 'Task not found' };
          }
        } else if (name === 're_triage_task' && typeof args.taskId === 'string') {
          const existing = getTaskDetail(args.taskId);
          if (!existing) {
            toolResult = { ok: false, error: 'Task not found' };
          } else {
            const extra =
              typeof args.extraInstruction === 'string' && args.extraInstruction.trim()
                ? `\n\nDODATKOWA WSKAZÓWKA DO PONOWNEGO TRIAGE: ${args.extraInstruction.trim()}`
                : '';
            const triage = await runTriage(
              `${existing.userPrompt}${extra}`,
              existing.attachments
            );
            const nextColumn: TaskColumn =
              triage.backgroundTaskType !== 'NONE'
                ? 'ai_processing'
                : triage.dueAt || triage.reminderAt
                  ? 'scheduled'
                  : 'ready_inbox';

            const updated = updateTask(existing.id, {
              title: triage.title,
              aiSummary: triage.aiSummary,
              aiReasoning: triage.aiReasoning,
              priority: triage.priority,
              category: triage.category,
              tags: triage.tags,
              backgroundTaskType: triage.backgroundTaskType,
              backgroundPrompt: triage.backgroundPrompt,
              dueAt: triage.dueAt,
              reminderAt: triage.reminderAt,
              needsClarification: triage.needsClarification,
              clarificationQuestion: triage.clarificationQuestion,
              columnStatus:
                existing.columnStatus === 'done' ? 'done' : nextColumn,
            });

            if (updated) {
              let finalTask = updated;
              eventBus.broadcast('task:updated', finalTask.id, finalTask);
              if (shouldAutoSyncTriageToCalendar(triage, config.calendarEnabled)) {
                try {
                  const synced = await syncTaskToCalendar(finalTask.id, {
                    start: triage.calendarEventStart,
                    end: triage.calendarEventEnd,
                    allDay: triage.calendarEventAllDay,
                    location: triage.calendarEventLocation,
                    autoAdded: true,
                  });
                  finalTask = synced.task;
                } catch (err) {
                  log.error('InboxRouter', 'Błąd synchronizacji kalendarza po re_triage', err);
                }
              } else if (finalTask.googleEventId) {
                await updateLinkedCalendarEventForTask(finalTask, {
                  titleChanged: finalTask.title !== existing.title,
                  dueAtChanged: Boolean(
                    finalTask.dueAt && finalTask.dueAt !== existing.dueAt
                  ),
                });
                finalTask = getTaskDetail(finalTask.id) ?? finalTask;
              }

              await refreshTaskEmbedOnDiscord(finalTask);
              await postTextToDiscordThread({
                task: finalTask,
                author: 'assistant',
                text: `🔄 **Ponowny triage zakończony:** ${finalTask.title}\n> ${finalTask.aiSummary}`,
                recordInDb: true,
                withActionButtons: true,
              });
              if (finalTask.backgroundTaskType !== 'NONE') {
                enqueueBackgroundWork(finalTask.id);
              }
              toolResult = {
                ok: true,
                title: finalTask.title,
                columnStatus: finalTask.columnStatus,
                backgroundTaskType: finalTask.backgroundTaskType,
                dueAt: finalTask.dueAt,
                reminderAt: finalTask.reminderAt,
                inCalendar: Boolean(finalTask.googleEventId),
              };
            }
          }
        } else if (
          name === 'rerun_task_research' &&
          typeof args.taskId === 'string'
        ) {
          const existing = getTaskDetail(args.taskId);
          if (!existing) {
            toolResult = { ok: false, error: 'Task not found' };
          } else {
            const updated = updateTask(existing.id, {
              columnStatus: 'ai_processing',
              backgroundTaskType:
                existing.backgroundTaskType === 'NONE'
                  ? 'WEB_RESEARCH'
                  : existing.backgroundTaskType,
            });
            if (updated) {
              eventBus.broadcast('task:updated', updated.id, updated);
              await refreshTaskEmbedOnDiscord(updated);
            }
            const instruction =
              typeof args.instruction === 'string' ? args.instruction : undefined;
            enqueueBackgroundWork(existing.id, instruction);
            toolResult = { ok: true, queued: true, title: existing.title };
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
                query: typeof args.query === 'string' ? args.query : undefined,
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
        } else if (name === 'create_calendar_event') {
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
              const taskId =
                typeof args.taskId === 'string' && args.taskId.trim()
                  ? args.taskId.trim()
                  : null;
              if (taskId) {
                const synced = await syncTaskToCalendar(taskId, {
                  title:
                    typeof args.summary === 'string' ? args.summary : undefined,
                  start: String(args.start ?? ''),
                  end: typeof args.end === 'string' ? args.end : null,
                  allDay:
                    typeof args.allDay === 'boolean' ? args.allDay : undefined,
                  description:
                    typeof args.description === 'string'
                      ? args.description
                      : undefined,
                  location:
                    typeof args.location === 'string' ? args.location : null,
                  reminderMinutes,
                  autoAdded: false,
                });
                toolResult = {
                  ok: true,
                  event: synced.event,
                  linkedTaskId: synced.task.id,
                };
              } else {
                const ev = await createCalendarEvent({
                  summary: String(args.summary ?? ''),
                  start: String(args.start ?? ''),
                  end: typeof args.end === 'string' ? args.end : null,
                  allDay:
                    typeof args.allDay === 'boolean' ? args.allDay : undefined,
                  description:
                    typeof args.description === 'string'
                      ? args.description
                      : null,
                  location:
                    typeof args.location === 'string' ? args.location : null,
                  reminderMinutes,
                });
                toolResult = { ok: true, event: ev };
              }
            } catch (err) {
              toolResult = {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        } else if (
          name === 'update_calendar_event' &&
          typeof args.eventId === 'string'
        ) {
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
              const updatedEv = await updateCalendarEvent(args.eventId, {
                summary:
                  typeof args.summary === 'string' ? args.summary : undefined,
                start: typeof args.start === 'string' ? args.start : undefined,
                end: typeof args.end === 'string' ? args.end : undefined,
                allDay:
                  typeof args.allDay === 'boolean' ? args.allDay : undefined,
                description:
                  typeof args.description === 'string'
                    ? args.description
                    : undefined,
                location:
                  typeof args.location === 'string' ? args.location : undefined,
                reminderMinutes,
              });

              const linkedTask = getTaskByGoogleEventId(args.eventId);
              if (linkedTask) {
                const taskPatch: Parameters<typeof updateTask>[1] = {
                  googleEventHtmlLink: updatedEv.htmlLink,
                  googleEventStart: updatedEv.start,
                  googleEventEnd: updatedEv.end,
                  googleEventAllDay: updatedEv.allDay,
                  googleEventLocation: updatedEv.location,
                };
                if (typeof args.summary === 'string' && args.summary.trim()) {
                  taskPatch.title = args.summary.trim().slice(0, 120);
                }
                if (updatedEv.start) {
                  taskPatch.dueAt = updatedEv.allDay
                    ? localDateTimeToIso(
                        updatedEv.start.slice(0, 10),
                        9,
                        0,
                        config.TIMEZONE
                      )
                    : updatedEv.start;
                }
                const updatedTask = updateTask(linkedTask.id, taskPatch);
                if (updatedTask) {
                  eventBus.broadcast('task:updated', updatedTask.id, updatedTask);
                  await refreshTaskEmbedOnDiscord(updatedTask);
                }
              }

              toolResult = {
                ok: true,
                event: updatedEv,
                linkedTaskId: linkedTask?.id ?? null,
              };
            } catch (err) {
              toolResult = {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        } else if (
          name === 'delete_calendar_event' &&
          typeof args.eventId === 'string'
        ) {
          if (!config.calendarEnabled) {
            toolResult = {
              ok: false,
              error: 'Kalendarz Google nie jest jeszcze skonfigurowany w .env.',
            };
          } else {
            try {
              const linkedTask = getTaskByGoogleEventId(args.eventId);
              if (linkedTask) {
                await removeTaskFromCalendar(linkedTask.id);
              } else {
                await deleteCalendarEvent(args.eventId);
              }
              toolResult = {
                ok: true,
                deletedEventId: args.eventId,
                unlinkedTaskId: linkedTask?.id ?? null,
              };
            } catch (err) {
              toolResult = {
                ok: false,
                error: err instanceof Error ? err.message : String(err),
              };
            }
          }
        } else if (
          name === 'sync_task_to_calendar' &&
          typeof args.taskId === 'string'
        ) {
          if (!config.calendarEnabled) {
            toolResult = {
              ok: false,
              error: 'Kalendarz Google nie jest jeszcze skonfigurowany w .env.',
            };
          } else {
            try {
              const synced = await syncTaskToCalendar(args.taskId, {
                start: typeof args.start === 'string' ? args.start : undefined,
                end: typeof args.end === 'string' ? args.end : undefined,
                allDay:
                  typeof args.allDay === 'boolean' ? args.allDay : undefined,
                location:
                  typeof args.location === 'string' ? args.location : undefined,
                autoAdded: false,
              });
              toolResult = {
                ok: true,
                taskId: synced.task.id,
                title: synced.task.title,
                event: synced.event,
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
          functionResponse: { name, response: toolResult },
        });
      }
      contents.push({ role: 'user', parts: responseParts });
    }

    return 'Gotowe — zaktualizowano zadanie.';
  } catch (err) {
    log.error('InboxRouter', 'Błąd odpowiedzi na zapytanie', err);
    return '⚠️ Przekroczono czas oczekiwania lub wystąpił błąd API AI podczas sprawdzania tablicy. Szczegóły są w logu serwera (`data/consiler.log`).';
  }
}
