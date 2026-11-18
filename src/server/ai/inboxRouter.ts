import { Type, type Content, type FunctionDeclaration, type Part } from '@google/genai';
import { z } from 'zod';
import { config } from '../config.js';
import { getTaskDetail, listTasks, updateTask } from '../db.js';
import { eventBus } from '../events.js';
import { log } from '../logger.js';
import {
  postTextToDiscordThread,
  refreshTaskEmbedOnDiscord,
  setDiscordThreadArchived,
} from '../discord/bridge.js';
import { formatDatePl } from '../discord/formatting.js';
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
1. "BOARD_QUERY" — pytanie o istniejące zadania na tablicy, kalendarz, terminy, przypomnienia, podsumowanie dnia/tygodnia, prośba o zmianę/zamknięcie/ponowny triage/research istniejącego zadania, lub pytanie do asystenta o jego działanie.
Przykłady BOARD_QUERY:
- "jakie mamy zadania na jutro?"
- "co mam dziś do zrobienia?"
- "pokaż zaległe zadania"
- "co wisi w inboxie?"
- "oznacz zadanie ze słuchawkami jako zrobione"
- "przeanalizuj jeszcze raz zadanie z Mateuszem" / "zrób ponowny triage zadania X"

2. "CREATE_TASK" — dodanie nowego zadania, rzeczy do zrobienia, przypomnienia do ustawienia, linku do sprawdzenia, tematu do researchu lub szkicu do napisania.
Przykłady CREATE_TASK:
- "kupić mleko i kawę jutro"
- "przypomnij w piątek o 14:00 opłacić fakturę"
- "sprawdź ile kosztuje nowy Kindle i czy warto"
- "napisać maila do księgowej w sprawie PIT"

Zasada ostrożności: jeśli wiadomość to pytanie o stan tablicy/agendy lub odwołuje się do już istniejącego zadania na tablicy -> wybierz "BOARD_QUERY".`,
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
          text: `AKTUALNY CZAS LOKALNY: ${nowLocal} (${now.toISOString()}, strefa: ${config.TIMEZONE})\n\nAKTUALNA ZAWARTOŚĆ TABLICY ZADAŃ (JSON):\n${JSON.stringify(snapshot, null, 2)}\n\nZAPYTANIE UŻYTKOWNIKA NA #inbox:\n"${userQuery}"`,
        },
      ],
    },
  ];

  try {
    for (let step = 0; step < 3; step++) {
      const response = await generateWithTimeout(
        `inbox-query-step-${step + 1}`,
        {
          model: config.GEMINI_TRIAGE_MODEL,
          contents,
          config: {
            systemInstruction: `Jesteś asystentem zadań Consiler odpowiadającym bezpośrednio na pytanie lub polecenie użytkownika na kanale #inbox (Discord).
ZASADY:
1. Analizuj daty DOKŁADNIE względem podanego AKTUALNEGO CZASU LOKALNEGO i strefy ${config.TIMEZONE}.
2. Jeśli użytkownik pyta o zadania na konkretny dzień (np. "na jutro", "na dziś"), wymień przede wszystkim zadania z dueAtLocal lub reminderAtLocal przypadającym na ten dzień (pomijaj zadania ze statusem "done", chyba że użytkownik pyta o ukończone).
3. Jeśli użytkownik prosi o ponowny triage / ponowną analizę istniejącego zadania — znajdź je w JSON i OBOWIĄZKOWO wywołaj narzędzie re_triage_task.
4. Jeśli użytkownik prosi o ponowny research — wywołaj rerun_task_research.
5. Jeśli prosi o zmianę statusu, zamknięcie lub przesunięcie terminu — wywołaj update_existing_task.
6. Przy każdym wymienionym zadaniu możesz dodać link w formacie Markdown [Otwórz](url). Odpowiadaj zwięźle i konkretnie po polsku.`,
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
              eventBus.broadcast('task:updated', updated.id, updated);
              await refreshTaskEmbedOnDiscord(updated);
              await postTextToDiscordThread({
                task: updated,
                author: 'assistant',
                text: `🔄 **Ponowny triage zakończony:** ${updated.title}\n> ${updated.aiSummary}`,
                recordInDb: true,
                withActionButtons: true,
              });
              if (updated.backgroundTaskType !== 'NONE') {
                enqueueBackgroundWork(updated.id);
              }
              toolResult = {
                ok: true,
                title: updated.title,
                columnStatus: updated.columnStatus,
                backgroundTaskType: updated.backgroundTaskType,
                dueAt: updated.dueAt,
                reminderAt: updated.reminderAt,
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
