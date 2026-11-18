import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
} from 'discord.js';
import { config } from '../config.js';
import type {
  CheckoutSession,
  TaskColumn,
  TaskDetail,
  TaskPriority,
} from '../types.js';

const COLUMN_META: Record<
  TaskColumn,
  { label: string; color: number }
> = {
  ai_processing: { label: '🤖 W analizie AI', color: 0x8b5cf6 },
  ready_inbox: { label: '✨ Gotowe do akcji', color: 0x3b82f6 },
  scheduled: { label: '📅 Zaplanowane / W toku', color: 0xf59e0b },
  done: { label: '✅ Zrobione', color: 0x10b981 },
};

const PRIORITY_LABELS: Record<TaskPriority, string> = {
  low: '🟢 Niski',
  medium: '🔵 Średni',
  high: '🟠 Wysoki',
  urgent: '🔴 Pilny',
};

export function formatDatePl(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return new Intl.DateTimeFormat('pl-PL', {
    timeZone: config.TIMEZONE,
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

export function buildTaskEmbed(task: TaskDetail): EmbedBuilder {
  const col = COLUMN_META[task.columnStatus] ?? COLUMN_META.ready_inbox;
  const completedCount = task.checklist.filter((c) => c.completed).length;

  const embed = new EmbedBuilder()
    .setColor(col.color)
    .setTitle(task.title.slice(0, 250))
    .setURL(`${config.APP_BASE_URL}/?task=${task.id}`)
    .setDescription(
      (task.aiSummary || task.userPrompt || 'Brak dodatkowego opisu.').slice(
        0,
        1500
      )
    )
    .addFields(
      { name: 'Status', value: col.label, inline: true },
      {
        name: 'Priorytet',
        value: PRIORITY_LABELS[task.priority] ?? task.priority,
        inline: true,
      },
      { name: 'Kategoria', value: task.category || 'Ogólne', inline: true }
    )
    .setTimestamp(new Date(task.updatedAt));

  if (task.dueAt) {
    embed.addFields({
      name: 'Termin',
      value: formatDatePl(task.dueAt),
      inline: true,
    });
  }
  if (task.reminderAt) {
    embed.addFields({
      name: 'Przypomnienie',
      value: formatDatePl(task.reminderAt),
      inline: true,
    });
  }
  if (task.checklist.length > 0) {
    embed.addFields({
      name: 'Podzadania',
      value: `${completedCount}/${task.checklist.length} ukończone`,
      inline: true,
    });
  }
  if (task.needsClarification && task.clarificationQuestion) {
    embed.addFields({
      name: '❓ Pytanie asystenta',
      value: task.clarificationQuestion.slice(0, 500),
      inline: false,
    });
  }

  return embed;
}

export function buildTaskActionRow(
  task: TaskDetail
): ActionRowBuilder<ButtonBuilder> {
  const isDone = task.columnStatus === 'done';
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`task_done:${task.id}`)
      .setLabel(isDone ? 'Przywróć' : 'Zrobione')
      .setEmoji(isDone ? '↩️' : '✅')
      .setStyle(isDone ? ButtonStyle.Secondary : ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`task_snooze_2h:${task.id}`)
      .setLabel('+2h')
      .setEmoji('⏰')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isDone),
    new ButtonBuilder()
      .setCustomId(`task_snooze_tomorrow:${task.id}`)
      .setLabel('Jutro 9:00')
      .setEmoji('📅')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(isDone),
    new ButtonBuilder()
      .setCustomId(`task_rerun_research:${task.id}`)
      .setLabel('Research')
      .setEmoji('🔍')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(task.columnStatus === 'ai_processing')
  );
  return row;
}

export function buildCheckoutActionRow(
  session: CheckoutSession
): ActionRowBuilder<ButtonBuilder> {
  const closed =
    session.status === 'COMPLETED' ||
    session.status === 'CANCELLED' ||
    session.status === 'FAILED';
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`checkout_launch:${session.id}`)
      .setLabel('Otwórz sesję na PC')
      .setEmoji('🖥️')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(closed || !session.storageStatePath),
    new ButtonBuilder()
      .setCustomId(`checkout_done:${session.id}`)
      .setLabel('Zamówione')
      .setEmoji('✅')
      .setStyle(ButtonStyle.Success)
      .setDisabled(closed),
    new ButtonBuilder()
      .setCustomId(`checkout_cancel:${session.id}`)
      .setLabel('Anuluj')
      .setEmoji('❌')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(closed)
  );
}

export function chunkDiscordText(text: string, maxLen = 1900): string[] {
  const clean = text.trim();
  if (!clean) return [];
  if (clean.length <= maxLen) return [clean];

  const chunks: string[] = [];
  let remaining = clean;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf('\n\n', maxLen);
    if (splitIdx < maxLen * 0.4) {
      splitIdx = remaining.lastIndexOf('\n', maxLen);
    }
    if (splitIdx < maxLen * 0.4) {
      splitIdx = remaining.lastIndexOf(' ', maxLen);
    }
    if (splitIdx <= 0) {
      splitIdx = maxLen;
    }
    chunks.push(remaining.slice(0, splitIdx).trim());
    remaining = remaining.slice(splitIdx).trim();
  }
  if (remaining) {
    chunks.push(remaining);
  }
  return chunks;
}
