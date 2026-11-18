import { Type, type Part } from '@google/genai';
import { z } from 'zod';
import { config } from '../config.js';
import type {
  BackgroundTaskType,
  TaskAttachment,
  TaskPriority,
} from '../types.js';
import { getGenAI, generateWithTimeout, loadAttachmentsAsParts } from './client.js';
import { buildTriageSystemPrompt } from './prompts.js';
import { log } from '../logger.js';

const TriageSchema = z.object({
  title: z.string().min(1),
  aiSummary: z.string(),
  aiReasoning: z.string(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).default('medium'),
  category: z.string().default('Ogólne'),
  tags: z.array(z.string()).default([]),
  backgroundTaskType: z
    .enum(['NONE', 'WEB_RESEARCH', 'DRAFT_CONTENT', 'ACTION_PLAN'])
    .default('NONE'),
  backgroundPrompt: z.string().nullable().default(null),
  dueAt: z.string().nullable().default(null),
  reminderAt: z.string().nullable().default(null),
  checklist: z.array(z.string()).default([]),
  needsClarification: z.boolean().default(false),
  clarificationQuestion: z.string().nullable().default(null),
});

export type TriageResult = z.infer<typeof TriageSchema>;

function normalizeIsoOrNull(val: string | null | undefined): string | null {
  if (!val || !val.trim()) return null;
  const date = new Date(val);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString();
}

export async function runTriage(
  userPrompt: string,
  attachments: TaskAttachment[]
): Promise<TriageResult> {
  const ai = getGenAI();
  const fallbackTitle =
    userPrompt.trim().slice(0, 70) ||
    (attachments.length > 0 ? 'Zadanie ze zrzutu ekranu' : 'Nowe zadanie');

  if (!ai) {
    return {
      title: fallbackTitle,
      aiSummary: userPrompt.trim() || 'Brak klucza GEMINI_API_KEY — zapisano surowy wpis.',
      aiReasoning: 'Tryb offline AI (brak GEMINI_API_KEY w .env).',
      priority: 'medium' as TaskPriority,
      category: 'Ogólne',
      tags: [],
      backgroundTaskType: 'NONE' as BackgroundTaskType,
      backgroundPrompt: null,
      dueAt: null,
      reminderAt: null,
      checklist: [],
      needsClarification: false,
      clarificationQuestion: null,
    };
  }

  const nowIso = new Date().toISOString();
  const imageParts = await loadAttachmentsAsParts(attachments);
  const parts: Part[] = [
    ...imageParts,
    {
      text: userPrompt.trim()
        ? `Wiadomość użytkownika: "${userPrompt.trim()}"`
        : 'Użytkownik przesłał zrzut ekranu bez dodatkowego opisu tekstowego. Przeanalizuj dokładnie zawartość obrazu i określ najlepsze działanie.',
    },
  ];

  try {
    const response = await generateWithTimeout(
      'triage',
      {
        model: config.GEMINI_TRIAGE_MODEL,
        contents: [{ role: 'user', parts }],
        config: {
          systemInstruction: buildTriageSystemPrompt(nowIso, config.TIMEZONE),
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.OBJECT,
            properties: {
              title: {
                type: Type.STRING,
                description: 'Krótki, konkretny tytuł zadania po polsku (max 80 znaków).',
              },
              aiSummary: {
                type: Type.STRING,
                description: 'Zwięzły opis kontekstu wyekstrahowanego ze screena i tekstu (2-4 zdania).',
              },
              aiReasoning: {
                type: Type.STRING,
                description: 'Krótkie uzasadnienie decyzji (dlaczego taki termin, priorytet i typ pracy w tle).',
              },
              priority: {
                type: Type.STRING,
                enum: ['low', 'medium', 'high', 'urgent'],
              },
              category: {
                type: Type.STRING,
                description: 'Jednowyrazowa kategoria, np. Zakupy, Praca, Finanse, Dom, Nauka, Tech.',
              },
              tags: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
              },
              backgroundTaskType: {
                type: Type.STRING,
                enum: ['NONE', 'WEB_RESEARCH', 'DRAFT_CONTENT', 'ACTION_PLAN'],
              },
              backgroundPrompt: {
                type: Type.STRING,
                nullable: true,
                description: 'Konkretna instrukcja dla agenta pracującego w tle (jeśli backgroundTaskType != NONE).',
              },
              dueAt: {
                type: Type.STRING,
                nullable: true,
                description: 'Termin wykonania w ISO-8601 lub null.',
              },
              reminderAt: {
                type: Type.STRING,
                nullable: true,
                description: 'Kiedy wysłać przypomnienie na Discorda (ISO-8601) lub null.',
              },
              checklist: {
                type: Type.ARRAY,
                items: { type: Type.STRING },
                description: 'Opcjonalne 0-4 konkretne podzadania.',
              },
              needsClarification: {
                type: Type.BOOLEAN,
              },
              clarificationQuestion: {
                type: Type.STRING,
                nullable: true,
              },
            },
            required: [
              'title',
              'aiSummary',
              'aiReasoning',
              'priority',
              'category',
              'tags',
              'backgroundTaskType',
              'needsClarification',
            ],
          },
        },
      },
      45_000
    );

    const rawText = response.text ?? '{}';
    const parsed = TriageSchema.parse(JSON.parse(rawText));
    log.info('Triage', `Wynik triage: "${parsed.title}"`, {
      bg: parsed.backgroundTaskType,
      dueAt: parsed.dueAt,
      reminderAt: parsed.reminderAt,
    });
    return {
      ...parsed,
      title: parsed.title.slice(0, 120),
      dueAt: normalizeIsoOrNull(parsed.dueAt),
      reminderAt: normalizeIsoOrNull(parsed.reminderAt),
      checklist: parsed.checklist.slice(0, 5),
    };
  } catch (err) {
    log.error('Triage', 'Błąd analizy AI', err);
    return {
      title: fallbackTitle,
      aiSummary:
        userPrompt.trim() ||
        'Nie udało się automatycznie przeanalizować zadania przez AI — zobacz załącznik.',
      aiReasoning:
        'Wystąpił błąd podczas analizy triage AI. Zadanie trafiło do skrzynki odbiorczej.',
      priority: 'medium',
      category: 'Ogólne',
      tags: [],
      backgroundTaskType: 'NONE',
      backgroundPrompt: null,
      dueAt: null,
      reminderAt: null,
      checklist: [],
      needsClarification: false,
      clarificationQuestion: null,
    };
  }
}
