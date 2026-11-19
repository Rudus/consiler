import cron from 'node-cron';
import { config } from './config.js';
import { getDueReminders, listTasks, updateTask } from './db.js';
import { eventBus } from './events.js';
import {
  sendDailyDigestToInbox,
  sendDiscordReminder,
} from './discord/bridge.js';
import { formatDatePl } from './discord/formatting.js';
import { log } from './logger.js';
import {
  getLocalDayBoundsIso,
  listCalendarEvents,
} from './services/googleCalendar.js';
import type { CalendarEventSummary } from './types.js';

let tasksList: cron.ScheduledTask[] = [];

function formatEventTimePl(iso: string, timeZone: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

async function checkReminders(): Promise<void> {
  const nowIso = new Date().toISOString();
  const due = getDueReminders(nowIso);
  for (const task of due) {
    const sent = await sendDiscordReminder(task);
    // Mark reminder as sent so we don't spam every minute; if Discord is disabled, still mark or keep?
    // Only mark sent when Discord delivered OR Discord is disabled (so dashboard doesn't endlessly retry)
    if (sent || !config.discordEnabled) {
      const updated = updateTask(task.id, { reminderSentAt: nowIso });
      if (updated) {
        eventBus.broadcast('task:updated', updated.id, updated);
      }
    }
  }
}

async function runDailyDigest(): Promise<void> {
  if (!config.discordEnabled) return;
  const all = listTasks().filter((t) => t.columnStatus !== 'done');
  const now = new Date();
  const bounds = getLocalDayBoundsIso(now, config.TIMEZONE);

  let calendarToday: CalendarEventSummary[] = [];
  if (config.calendarEnabled) {
    try {
      calendarToday = await listCalendarEvents({
        timeMin: bounds.startIso,
        timeMax: bounds.endIso,
      });
    } catch (err) {
      log.error('Scheduler', 'Nie udało się pobrać wydarzeń z kalendarza do Daily Digest', err);
    }
  }

  if (all.length === 0 && calendarToday.length === 0) return;

  const startMs = new Date(bounds.startIso).getTime();
  const endMs = new Date(bounds.endIso).getTime();

  const calendarEventIds = new Set(calendarToday.map((e) => e.id));
  const calendarTaskIds = new Set(
    calendarToday
      .map((e) => e.consilerTaskId)
      .filter((id): id is string => Boolean(id))
  );

  const overdue = all.filter(
    (t) => t.dueAt && new Date(t.dueAt).getTime() < now.getTime()
  );
  const today = all.filter(
    (t) =>
      t.dueAt &&
      new Date(t.dueAt).getTime() >= Math.max(now.getTime(), startMs) &&
      new Date(t.dueAt).getTime() <= endMs &&
      !(t.googleEventId && calendarEventIds.has(t.googleEventId)) &&
      !calendarTaskIds.has(t.id)
  );
  const readyResearch = all.filter(
    (t) => t.columnStatus === 'ready_inbox' && Boolean(t.researchReport)
  );

  if (
    calendarToday.length === 0 &&
    overdue.length === 0 &&
    today.length === 0 &&
    readyResearch.length === 0
  ) {
    return;
  }

  const mention = config.ALLOWED_DISCORD_USER_ID
    ? `<@${config.ALLOWED_DISCORD_USER_ID}>`
    : '';
  const lines: string[] = [
    `${mention} ☀️ **Poranny przegląd zadań (Consiler)**`,
    '',
  ];

  if (calendarToday.length > 0) {
    lines.push(`🗓️ **Kalendarz „${config.GOOGLE_CALENDAR_NAME}” na dziś:**`);
    for (const ev of calendarToday.slice(0, 10)) {
      const when = ev.allDay
        ? 'Cały dzień'
        : formatEventTimePl(ev.start, config.TIMEZONE);
      const loc = ev.location ? ` *(${ev.location})*` : '';
      lines.push(`• **${when}** — ${ev.summary}${loc}`);
    }
    lines.push('');
  }

  if (overdue.length > 0) {
    lines.push('🔴 **Zaległe terminy:**');
    for (const t of overdue.slice(0, 6)) {
      lines.push(`• **${t.title}** (termin: ${formatDatePl(t.dueAt)})`);
    }
    lines.push('');
  }

  if (today.length > 0) {
    lines.push('📅 **Na dziś (zadania):**');
    for (const t of today.slice(0, 8)) {
      lines.push(`• **${t.title}** (${formatDatePl(t.dueAt)})`);
    }
    lines.push('');
  }

  if (readyResearch.length > 0) {
    lines.push('✨ **Gotowe researche / materiały do przejrzenia:**');
    for (const t of readyResearch.slice(0, 8)) {
      lines.push(`• **${t.title}**`);
    }
    lines.push('');
  }

  lines.push(`🔗 [Otwórz tablicę zadań](${config.APP_BASE_URL})`);
  await sendDailyDigestToInbox(lines.join('\n'));
}

export function startScheduler(): void {
  // Check due reminders every minute
  const reminderJob = cron.schedule(
    '* * * * *',
    () => {
      void checkReminders();
    },
    { timezone: config.TIMEZONE }
  );

  // Daily digest
  const digestJob = cron.schedule(
    config.DAILY_DIGEST_CRON,
    () => {
      void runDailyDigest();
    },
    { timezone: config.TIMEZONE }
  );

  tasksList = [reminderJob, digestJob];
  console.log(
    `[Scheduler] Uruchomiono (strefa: ${config.TIMEZONE}, digest: ${config.DAILY_DIGEST_CRON})`
  );
}

export function stopScheduler(): void {
  for (const job of tasksList) {
    job.stop();
  }
  tasksList = [];
}
