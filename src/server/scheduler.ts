import cron from 'node-cron';
import { config } from './config.js';
import { getDueReminders, listTasks, updateTask } from './db.js';
import { eventBus } from './events.js';
import {
  sendDailyDigestToInbox,
  sendDiscordReminder,
} from './discord/bridge.js';
import { formatDatePl } from './discord/formatting.js';

let tasksList: cron.ScheduledTask[] = [];

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
  if (all.length === 0) return;

  const now = new Date();
  const endOfToday = new Date(now);
  endOfToday.setHours(23, 59, 59, 999);

  const overdue = all.filter(
    (t) => t.dueAt && new Date(t.dueAt).getTime() < now.getTime()
  );
  const today = all.filter(
    (t) =>
      t.dueAt &&
      new Date(t.dueAt).getTime() >= now.getTime() &&
      new Date(t.dueAt).getTime() <= endOfToday.getTime()
  );
  const readyResearch = all.filter(
    (t) => t.columnStatus === 'ready_inbox' && Boolean(t.researchReport)
  );

  if (overdue.length === 0 && today.length === 0 && readyResearch.length === 0) {
    return;
  }

  const mention = config.ALLOWED_DISCORD_USER_ID
    ? `<@${config.ALLOWED_DISCORD_USER_ID}>`
    : '';
  const lines: string[] = [
    `${mention} ☀️ **Poranny przegląd zadań (Consiler)**`,
    '',
  ];

  if (overdue.length > 0) {
    lines.push('🔴 **Zaległe terminy:**');
    for (const t of overdue.slice(0, 6)) {
      lines.push(`• **${t.title}** (termin: ${formatDatePl(t.dueAt)})`);
    }
    lines.push('');
  }

  if (today.length > 0) {
    lines.push('📅 **Na dziś:**');
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
