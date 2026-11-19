import crypto from 'node:crypto';
import fs from 'node:fs';
import { config } from '../config.js';
import { getTaskDetail, updateTask } from '../db.js';
import { refreshTaskEmbedOnDiscord } from '../discord/bridge.js';
import { eventBus } from '../events.js';
import { log } from '../logger.js';
import type { CalendarEventSummary, TaskDetail } from '../types.js';

const CALENDAR_SCOPE = 'https://www.googleapis.com/auth/calendar';
const DEFAULT_TOKEN_URI = 'https://oauth2.googleapis.com/token';
const CALENDAR_API_BASE = 'https://www.googleapis.com/calendar/v3';
const REQUEST_TIMEOUT_MS = 15_000;

export interface ServiceAccountCredentials {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

interface CachedToken {
  accessToken: string;
  expiresAtMs: number;
  clientEmail: string;
}

let cachedToken: CachedToken | null = null;

function base64UrlEncode(input: Buffer | string): string {
  const buf = typeof input === 'string' ? Buffer.from(input, 'utf8') : input;
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

export function loadServiceAccountCredentials(): ServiceAccountCredentials {
  let rawJson = config.GOOGLE_SERVICE_ACCOUNT_JSON.trim();
  if (!rawJson) {
    if (!config.googleServiceAccountPath) {
      throw new Error(
        'Brak poświadczeń Google Service Account (GOOGLE_SERVICE_ACCOUNT_PATH / GOOGLE_SERVICE_ACCOUNT_JSON).'
      );
    }
    if (!fs.existsSync(config.googleServiceAccountPath)) {
      throw new Error(
        `Nie znaleziono pliku klucza Service Account: ${config.googleServiceAccountPath}`
      );
    }
    rawJson = fs.readFileSync(config.googleServiceAccountPath, 'utf8').trim();
  } else if (!rawJson.startsWith('{')) {
    rawJson = Buffer.from(rawJson, 'base64').toString('utf8').trim();
  }

  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(rawJson) as Record<string, unknown>;
  } catch {
    throw new Error(
      'Nieprawidłowy format JSON w poświadczeniach Google Service Account.'
    );
  }

  const clientEmail =
    typeof parsed.client_email === 'string' ? parsed.client_email.trim() : '';
  const privateKeyRaw =
    typeof parsed.private_key === 'string' ? parsed.private_key : '';
  const privateKey = privateKeyRaw.replace(/\\n/g, '\n').trim();
  const tokenUri =
    typeof parsed.token_uri === 'string' && parsed.token_uri.trim()
      ? parsed.token_uri.trim()
      : DEFAULT_TOKEN_URI;

  if (!clientEmail || !privateKey) {
    throw new Error(
      'Plik Google Service Account nie zawiera pól client_email oraz private_key.'
    );
  }

  return {
    client_email: clientEmail,
    private_key: privateKey,
    token_uri: tokenUri,
  };
}

export function createServiceAccountJwt(
  creds: ServiceAccountCredentials,
  scope: string = CALENDAR_SCOPE,
  nowSec: number = Math.floor(Date.now() / 1000)
): string {
  const header = { alg: 'RS256', typ: 'JWT' };
  const payload = {
    iss: creds.client_email,
    scope,
    aud: creds.token_uri || DEFAULT_TOKEN_URI,
    iat: nowSec,
    exp: nowSec + 3600,
  };

  const signingInput = `${base64UrlEncode(JSON.stringify(header))}.${base64UrlEncode(JSON.stringify(payload))}`;
  const signer = crypto.createSign('RSA-SHA256');
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(creds.private_key);
  return `${signingInput}.${base64UrlEncode(signature)}`;
}

async function getAccessToken(): Promise<{ token: string; clientEmail: string }> {
  const creds = loadServiceAccountCredentials();
  if (
    cachedToken &&
    cachedToken.clientEmail === creds.client_email &&
    Date.now() < cachedToken.expiresAtMs - 60_000
  ) {
    return { token: cachedToken.accessToken, clientEmail: cachedToken.clientEmail };
  }

  const jwt = createServiceAccountJwt(creds, CALENDAR_SCOPE);
  const tokenUri = creds.token_uri || DEFAULT_TOKEN_URI;

  const body = new URLSearchParams({
    grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
    assertion: jwt,
  });

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(
      `Błąd autoryzacji Google OAuth (${res.status}): ${errText.slice(0, 300)}`
    );
  }

  const data = (await res.json()) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!data.access_token) {
    throw new Error('Google OAuth nie zwróciło access_token.');
  }

  const expiresInSec = typeof data.expires_in === 'number' ? data.expires_in : 3600;
  cachedToken = {
    accessToken: data.access_token,
    expiresAtMs: Date.now() + expiresInSec * 1000,
    clientEmail: creds.client_email,
  };

  return { token: cachedToken.accessToken, clientEmail: creds.client_email };
}

class GoogleApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

async function calendarApiRequest<T>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  pathSuffix: string,
  body?: unknown
): Promise<T> {
  const calendarId = config.GOOGLE_CALENDAR_ID.trim();
  if (!calendarId) {
    throw new Error('Brak GOOGLE_CALENDAR_ID w konfiguracji.');
  }

  const { token } = await getAccessToken();
  const url = `${CALENDAR_API_BASE}${pathSuffix}`;

  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

  if (method === 'DELETE' && (res.status === 204 || res.status === 404 || res.status === 410)) {
    return undefined as T;
  }

  if (!res.ok) {
    const errBody = await res.text().catch(() => '');
    throw new GoogleApiError(
      res.status,
      `Google Calendar API (${res.status}): ${errBody.slice(0, 350)}`
    );
  }

  if (res.status === 204) {
    return undefined as T;
  }
  return (await res.json()) as T;
}

export function addDaysToYmd(ymd: string, days: number): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!match) {
    throw new Error(`Nieprawidłowy format daty YYYY-MM-DD: ${ymd}`);
  }
  const utc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]) + days
  );
  return new Date(utc).toISOString().slice(0, 10);
}

export function formatDateInTimezoneYmd(
  isoOrDate: string | Date,
  timeZone: string = config.TIMEZONE
): string {
  const d = isoOrDate instanceof Date ? isoOrDate : new Date(isoOrDate);
  if (Number.isNaN(d.getTime())) {
    throw new Error(`Nieprawidłowa data: ${String(isoOrDate)}`);
  }
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(d);
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  const day = parts.find((p) => p.type === 'day')?.value;
  return `${year}-${month}-${day}`;
}

function getTimeZoneParts(
  date: Date,
  timeZone: string
): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(date);

  const getNum = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  const rawHour = getNum('hour');
  return {
    year: getNum('year'),
    month: getNum('month'),
    day: getNum('day'),
    hour: rawHour === 24 ? 0 : rawHour,
    minute: getNum('minute'),
    second: getNum('second'),
  };
}

export function localDateTimeToIso(
  ymd: string,
  hour: number,
  minute: number,
  timeZone: string = config.TIMEZONE,
  second = 0,
  ms = 0
): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd.trim());
  if (!match) {
    throw new Error(`Nieprawidłowy format daty YYYY-MM-DD: ${ymd}`);
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);

  const targetUtcGuess = Date.UTC(year, month - 1, day, hour, minute, second, ms);

  const measureOffset = (probeMs: number): number => {
    const tz = getTimeZoneParts(new Date(probeMs), timeZone);
    const asUtc = Date.UTC(
      tz.year,
      tz.month - 1,
      tz.day,
      tz.hour,
      tz.minute,
      tz.second,
      ms
    );
    return asUtc - probeMs;
  };

  const offset1 = measureOffset(targetUtcGuess);
  const candidate = targetUtcGuess - offset1;
  const offset2 = measureOffset(candidate);
  return new Date(targetUtcGuess - offset2).toISOString();
}

export function getLocalDayBoundsIso(
  date: Date,
  timeZone: string = config.TIMEZONE
): { startIso: string; endIso: string } {
  const ymd = formatDateInTimezoneYmd(date, timeZone);
  return {
    startIso: localDateTimeToIso(ymd, 0, 0, timeZone, 0, 0),
    endIso: localDateTimeToIso(ymd, 23, 59, timeZone, 59, 999),
  };
}

export function buildGoogleEventTimePayload(params: {
  start: string;
  end?: string | null;
  allDay?: boolean;
  timeZone?: string;
  forPatch?: boolean;
}): {
  start: Record<string, string | null>;
  end: Record<string, string | null>;
  allDay: boolean;
  normalizedStart: string;
  normalizedEnd: string;
} {
  const tz = params.timeZone || config.TIMEZONE;
  const rawStart = params.start.trim();
  if (!rawStart) {
    throw new Error('Brak daty rozpoczęcia wydarzenia.');
  }

  const isDateOnly = /^\d{4}-\d{2}-\d{2}$/.test(rawStart);
  const allDay = Boolean(params.allDay);

  if (allDay) {
    const startDate = isDateOnly
      ? rawStart
      : formatDateInTimezoneYmd(rawStart, tz);

    let endDate = addDaysToYmd(startDate, 1);
    if (params.end && params.end.trim()) {
      const rawEnd = params.end.trim();
      const parsedEndDate = /^\d{4}-\d{2}-\d{2}$/.test(rawEnd)
        ? rawEnd
        : formatDateInTimezoneYmd(rawEnd, tz);
      if (parsedEndDate > startDate) {
        endDate = parsedEndDate;
      }
    }

    return {
      start: params.forPatch
        ? { date: startDate, dateTime: null }
        : { date: startDate },
      end: params.forPatch
        ? { date: endDate, dateTime: null }
        : { date: endDate },
      allDay: true,
      normalizedStart: startDate,
      normalizedEnd: endDate,
    };
  }

  const startIso = isDateOnly
    ? localDateTimeToIso(rawStart, 9, 0, tz)
    : new Date(rawStart).toISOString();
  if (Number.isNaN(new Date(startIso).getTime())) {
    throw new Error(`Nieprawidłowa data rozpoczęcia: ${params.start}`);
  }
  const startMs = new Date(startIso).getTime();

  let endIso = new Date(startMs + 60 * 60 * 1000).toISOString();
  if (params.end && params.end.trim()) {
    const rawEnd = params.end.trim();
    const candidateIso = /^\d{4}-\d{2}-\d{2}$/.test(rawEnd)
      ? localDateTimeToIso(rawEnd, 10, 0, tz)
      : new Date(rawEnd).toISOString();
    const endMs = new Date(candidateIso).getTime();
    if (!Number.isNaN(endMs) && endMs > startMs) {
      endIso = candidateIso;
    }
  }

  return {
    start: params.forPatch
      ? { dateTime: startIso, timeZone: tz, date: null }
      : { dateTime: startIso, timeZone: tz },
    end: params.forPatch
      ? { dateTime: endIso, timeZone: tz, date: null }
      : { dateTime: endIso, timeZone: tz },
    allDay: false,
    normalizedStart: startIso,
    normalizedEnd: endIso,
  };
}

export function buildGoogleRemindersPayload(
  reminderMinutes?: number[] | null
): {
  useDefault: boolean;
  overrides?: Array<{ method: 'popup'; minutes: number }>;
} {
  if (!reminderMinutes || reminderMinutes.length === 0) {
    return { useDefault: true };
  }
  const cleaned = Array.from(
    new Set(
      reminderMinutes
        .filter((m) => typeof m === 'number' && Number.isFinite(m))
        .map((m) => Math.max(0, Math.min(40320, Math.round(m))))
    )
  ).slice(0, 5);

  if (cleaned.length === 0) {
    return { useDefault: true };
  }
  return {
    useDefault: false,
    overrides: cleaned.map((minutes) => ({ method: 'popup' as const, minutes })),
  };
}

export function shouldAutoSyncTriageToCalendar(
  triage: {
    shouldAddToCalendar?: boolean;
    calendarEventStart?: string | null;
  },
  calendarEnabled: boolean
): boolean {
  if (!calendarEnabled) return false;
  if (triage.shouldAddToCalendar !== true) return false;
  const raw = triage.calendarEventStart?.trim();
  if (!raw) return false;
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return true;
  return !Number.isNaN(new Date(raw).getTime());
}

export function formatCalendarEventWhenPl(
  start: string | null,
  end: string | null,
  allDay: boolean,
  timeZone: string = config.TIMEZONE
): string {
  if (!start) return '—';
  if (allDay || /^\d{4}-\d{2}-\d{2}$/.test(start.trim())) {
    const startYmd = start.trim().slice(0, 10);
    const fmt = new Intl.DateTimeFormat('pl-PL', {
      timeZone: 'UTC',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
    });
    const startLabel = fmt.format(new Date(`${startYmd}T12:00:00Z`));
    if (end && /^\d{4}-\d{2}-\d{2}$/.test(end.trim())) {
      const nextDay = addDaysToYmd(startYmd, 1);
      if (end.trim() > nextDay) {
        const inclusiveEnd = addDaysToYmd(end.trim(), -1);
        const endLabel = fmt.format(new Date(`${inclusiveEnd}T12:00:00Z`));
        return `${startLabel} – ${endLabel} (cały dzień)`;
      }
    }
    return `${startLabel} (cały dzień)`;
  }

  const startDate = new Date(start);
  if (Number.isNaN(startDate.getTime())) return start;
  const dateFmt = new Intl.DateTimeFormat('pl-PL', {
    timeZone,
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const startText = dateFmt.format(startDate);
  if (!end) return startText;

  const endDate = new Date(end);
  if (Number.isNaN(endDate.getTime())) return startText;
  const sameDay =
    formatDateInTimezoneYmd(startDate, timeZone) ===
    formatDateInTimezoneYmd(endDate, timeZone);
  if (sameDay) {
    const timeFmt = new Intl.DateTimeFormat('pl-PL', {
      timeZone,
      hour: '2-digit',
      minute: '2-digit',
    });
    return `${startText}–${timeFmt.format(endDate)}`;
  }
  return `${startText} – ${dateFmt.format(endDate)}`;
}

interface RawGoogleEvent {
  id: string;
  summary?: string;
  description?: string;
  location?: string;
  htmlLink?: string;
  status?: string;
  start?: { date?: string; dateTime?: string };
  end?: { date?: string; dateTime?: string };
  extendedProperties?: {
    private?: Record<string, string>;
  };
}

function mapGoogleEvent(ev: RawGoogleEvent): CalendarEventSummary {
  const allDay = Boolean(ev.start?.date && !ev.start?.dateTime);
  return {
    id: ev.id,
    summary: ev.summary || '(bez tytułu)',
    description: ev.description ?? null,
    location: ev.location ?? null,
    start: ev.start?.dateTime ?? ev.start?.date ?? '',
    end: ev.end?.dateTime ?? ev.end?.date ?? '',
    allDay,
    htmlLink: ev.htmlLink ?? null,
    status: ev.status ?? 'confirmed',
    consilerTaskId: ev.extendedProperties?.private?.consilerTaskId ?? null,
  };
}

export async function verifyCalendarConnection(): Promise<{
  ok: boolean;
  summary?: string;
  timeZone?: string;
  serviceAccountEmail?: string;
  error?: string;
}> {
  if (!config.calendarEnabled) {
    return {
      ok: false,
      error:
        'Kalendarz nie jest skonfigurowany (uzupełnij GOOGLE_CALENDAR_ID oraz plik/JSON Service Account w .env).',
    };
  }
  try {
    const creds = loadServiceAccountCredentials();
    const calId = encodeURIComponent(config.GOOGLE_CALENDAR_ID.trim());
    const cal = await calendarApiRequest<{
      id: string;
      summary?: string;
      timeZone?: string;
    }>('GET', `/calendars/${calId}`);
    return {
      ok: true,
      summary: cal.summary || config.GOOGLE_CALENDAR_NAME,
      timeZone: cal.timeZone || config.TIMEZONE,
      serviceAccountEmail: creds.client_email,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error('GoogleCalendar', 'Błąd weryfikacji połączenia z kalendarzem', err);
    return { ok: false, error: msg };
  }
}

export async function listCalendarEvents(params: {
  timeMin: string;
  timeMax: string;
  query?: string;
  maxResults?: number;
}): Promise<CalendarEventSummary[]> {
  if (!config.calendarEnabled) return [];
  const calId = encodeURIComponent(config.GOOGLE_CALENDAR_ID.trim());
  const qs = new URLSearchParams({
    singleEvents: 'true',
    orderBy: 'startTime',
    timeMin: new Date(params.timeMin).toISOString(),
    timeMax: new Date(params.timeMax).toISOString(),
    timeZone: config.TIMEZONE,
    maxResults: String(Math.min(Math.max(params.maxResults ?? 50, 1), 250)),
  });
  if (params.query && params.query.trim()) {
    qs.set('q', params.query.trim());
  }

  const res = await calendarApiRequest<{ items?: RawGoogleEvent[] }>(
    'GET',
    `/calendars/${calId}/events?${qs.toString()}`
  );
  return (res.items ?? []).map(mapGoogleEvent);
}

export async function createCalendarEvent(input: {
  summary: string;
  start: string;
  end?: string | null;
  allDay?: boolean;
  description?: string | null;
  location?: string | null;
  reminderMinutes?: number[] | null;
  taskId?: string | null;
}): Promise<CalendarEventSummary> {
  const calId = encodeURIComponent(config.GOOGLE_CALENDAR_ID.trim());
  const times = buildGoogleEventTimePayload({
    start: input.start,
    end: input.end,
    allDay: input.allDay,
    timeZone: config.TIMEZONE,
    forPatch: false,
  });

  const payload: Record<string, unknown> = {
    summary: input.summary.trim(),
    start: times.start,
    end: times.end,
    reminders: buildGoogleRemindersPayload(input.reminderMinutes),
  };
  if (input.description !== undefined && input.description !== null) {
    payload.description = input.description;
  }
  if (input.location !== undefined && input.location !== null && input.location.trim()) {
    payload.location = input.location.trim();
  }
  if (input.taskId) {
    payload.extendedProperties = {
      private: { consilerTaskId: input.taskId },
    };
  }

  const created = await calendarApiRequest<RawGoogleEvent>(
    'POST',
    `/calendars/${calId}/events`,
    payload
  );
  log.info('GoogleCalendar', `Utworzono wydarzenie: "${created.summary}"`, {
    eventId: created.id,
    taskId: input.taskId ?? undefined,
  });
  return mapGoogleEvent(created);
}

export async function updateCalendarEvent(
  eventId: string,
  patch: {
    summary?: string;
    start?: string;
    end?: string | null;
    allDay?: boolean;
    description?: string | null;
    location?: string | null;
    reminderMinutes?: number[] | null;
  }
): Promise<CalendarEventSummary> {
  const calId = encodeURIComponent(config.GOOGLE_CALENDAR_ID.trim());
  const payload: Record<string, unknown> = {};

  if (patch.summary !== undefined) {
    payload.summary = patch.summary.trim();
  }
  if (patch.description !== undefined) {
    payload.description = patch.description ?? '';
  }
  if (patch.location !== undefined) {
    payload.location = patch.location ?? '';
  }
  if (patch.start !== undefined) {
    const times = buildGoogleEventTimePayload({
      start: patch.start,
      end: patch.end,
      allDay: patch.allDay,
      timeZone: config.TIMEZONE,
      forPatch: true,
    });
    payload.start = times.start;
    payload.end = times.end;
  }
  if (patch.reminderMinutes !== undefined) {
    payload.reminders = buildGoogleRemindersPayload(patch.reminderMinutes);
  }

  const updated = await calendarApiRequest<RawGoogleEvent>(
    'PATCH',
    `/calendars/${calId}/events/${encodeURIComponent(eventId)}`,
    payload
  );
  log.info('GoogleCalendar', `Zaktualizowano wydarzenie: "${updated.summary}"`, {
    eventId: updated.id,
  });
  return mapGoogleEvent(updated);
}

export async function deleteCalendarEvent(eventId: string): Promise<boolean> {
  const calId = encodeURIComponent(config.GOOGLE_CALENDAR_ID.trim());
  await calendarApiRequest<void>(
    'DELETE',
    `/calendars/${calId}/events/${encodeURIComponent(eventId)}`
  );
  log.info('GoogleCalendar', `Usunięto wydarzenie ${eventId}`);
  return true;
}

function buildCalendarEventDescription(task: TaskDetail): string {
  const lines: string[] = [];
  if (task.aiSummary) lines.push(task.aiSummary);
  if (task.userPrompt && task.userPrompt !== task.aiSummary) {
    lines.push(`Wpis: ${task.userPrompt}`);
  }
  lines.push(`Consiler: ${config.APP_BASE_URL}/?task=${task.id}`);
  return lines.join('\n\n');
}

export async function syncTaskToCalendar(
  taskId: string,
  options?: {
    start?: string | null;
    end?: string | null;
    allDay?: boolean;
    location?: string | null;
    title?: string;
    description?: string | null;
    reminderMinutes?: number[] | null;
    autoAdded?: boolean;
    skipDiscordRefresh?: boolean;
  }
): Promise<{ task: TaskDetail; event: CalendarEventSummary }> {
  if (!config.calendarEnabled) {
    throw new Error(
      'Integracja z Google Calendar nie jest jeszcze skonfigurowana (.env).'
    );
  }
  const task = getTaskDetail(taskId);
  if (!task) {
    throw new Error('Nie znaleziono zadania.');
  }

  const start =
    options?.start?.trim() ||
    task.googleEventStart ||
    task.dueAt ||
    task.reminderAt;

  if (!start) {
    throw new Error(
      'Zadanie nie ma ustalonego terminu. Podaj datę lub napisz w wątku kiedy ma się odbyć.'
    );
  }

  const isDateOnlyStart = /^\d{4}-\d{2}-\d{2}$/.test(start);
  const allDay =
    options?.allDay !== undefined
      ? options.allDay
      : options?.start
        ? isDateOnlyStart
        : task.googleEventStart
          ? task.googleEventAllDay
          : isDateOnlyStart;

  const summary = (options?.title ?? task.title).trim() || task.title;
  const description =
    options?.description !== undefined
      ? options.description
      : buildCalendarEventDescription(task);
  const location =
    options?.location !== undefined ? options.location : task.googleEventLocation;

  let event: CalendarEventSummary;
  let wasCreated = false;

  if (task.googleEventId) {
    try {
      event = await updateCalendarEvent(task.googleEventId, {
        summary,
        start,
        end: options?.end !== undefined ? options.end : task.googleEventEnd,
        allDay,
        description,
        location,
        reminderMinutes: options?.reminderMinutes,
      });
    } catch (err) {
      if (err instanceof GoogleApiError && (err.status === 404 || err.status === 410)) {
        event = await createCalendarEvent({
          summary,
          start,
          end: options?.end ?? null,
          allDay,
          description,
          location,
          reminderMinutes: options?.reminderMinutes,
          taskId: task.id,
        });
        wasCreated = true;
      } else {
        throw err;
      }
    }
  } else {
    event = await createCalendarEvent({
      summary,
      start,
      end: options?.end ?? null,
      allDay,
      description,
      location,
      reminderMinutes: options?.reminderMinutes,
      taskId: task.id,
    });
    wasCreated = true;
  }

  const patch: Parameters<typeof updateTask>[1] = {
    googleEventId: event.id,
    googleEventHtmlLink: event.htmlLink,
    googleEventStart: event.start,
    googleEventEnd: event.end,
    googleEventAllDay: event.allDay,
    googleEventLocation: event.location,
  };

  if (wasCreated) {
    patch.googleEventAutoAdded = Boolean(options?.autoAdded);
  } else if (options?.autoAdded !== undefined) {
    patch.googleEventAutoAdded = options.autoAdded;
  }

  if (!task.dueAt && event.start) {
    patch.dueAt = event.allDay
      ? localDateTimeToIso(event.start.slice(0, 10), 9, 0, config.TIMEZONE)
      : event.start;
  }
  if (task.columnStatus === 'ready_inbox') {
    patch.columnStatus = 'scheduled';
  }

  const updated = updateTask(task.id, patch) ?? task;
  eventBus.broadcast('task:updated', updated.id, updated);
  if (!options?.skipDiscordRefresh) {
    await refreshTaskEmbedOnDiscord(updated);
  }

  return { task: updated, event };
}

export async function updateLinkedCalendarEventForTask(
  task: TaskDetail,
  opts?: { titleChanged?: boolean; dueAtChanged?: boolean }
): Promise<void> {
  if (!config.calendarEnabled || !task.googleEventId) return;
  try {
    const patch: Parameters<typeof updateCalendarEvent>[1] = {
      summary: task.title,
      description: buildCalendarEventDescription(task),
    };
    if (opts?.dueAtChanged && task.dueAt) {
      patch.start = task.dueAt;
      patch.allDay = false;
    }

    const event = await updateCalendarEvent(task.googleEventId, patch);
    const synced = updateTask(task.id, {
      googleEventHtmlLink: event.htmlLink,
      googleEventStart: event.start,
      googleEventEnd: event.end,
      googleEventAllDay: event.allDay,
      googleEventLocation: event.location,
    });
    if (synced) {
      eventBus.broadcast('task:updated', synced.id, synced);
      await refreshTaskEmbedOnDiscord(synced);
    }
  } catch (err) {
    log.error(
      'GoogleCalendar',
      `Nie udało się zaktualizować powiązanego wydarzenia ${task.googleEventId}`,
      err
    );
  }
}

export async function removeTaskFromCalendar(
  taskId: string
): Promise<{ task: TaskDetail; removed: boolean }> {
  const task = getTaskDetail(taskId);
  if (!task) {
    throw new Error('Nie znaleziono zadania.');
  }

  const hadEvent = Boolean(task.googleEventId);
  if (task.googleEventId && config.calendarEnabled) {
    await deleteCalendarEvent(task.googleEventId);
  }

  const updated =
    updateTask(task.id, {
      googleEventId: null,
      googleEventHtmlLink: null,
      googleEventStart: null,
      googleEventEnd: null,
      googleEventAllDay: false,
      googleEventLocation: null,
      googleEventAutoAdded: false,
    }) ?? task;

  eventBus.broadcast('task:updated', updated.id, updated);
  await refreshTaskEmbedOnDiscord(updated);

  return { task: updated, removed: hadEvent };
}
