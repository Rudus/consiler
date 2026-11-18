import fs from 'node:fs/promises';
import path from 'node:path';
import {
  Client,
  Events,
  GatewayIntentBits,
  type Interaction,
  type Message,
} from 'discord.js';
import { config } from '../config.js';
import {
  deleteTask,
  getTaskByDiscordThreadId,
  getTaskDetail,
  updateTask,
} from '../db.js';
import { eventBus } from '../events.js';
import { log } from '../logger.js';
import { enqueueBackgroundWork } from '../ai/researchWorker.js';
import {
  finishCheckoutSession,
  launchCheckoutSessionLocal,
} from '../ai/checkoutAgent.js';
import {
  createTaskFromDiscord,
  handleDiscordThreadMessage,
} from '../services/intake.js';
import {
  refreshTaskEmbedOnDiscord,
  setDiscordClient,
  setDiscordThreadArchived,
} from './bridge.js';
import {
  buildCheckoutActionRow,
  buildTaskActionRow,
  buildTaskEmbed,
  formatDatePl,
} from './formatting.js';

function computeTomorrowMorningIso(timezone: string, hour = 9): string {
  const now = new Date();
  const targetDay = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  // Format targetDay parts in the target timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(targetDay);
  const year = Number(parts.find((p) => p.type === 'year')?.value);
  const month = Number(parts.find((p) => p.type === 'month')?.value);
  const day = Number(parts.find((p) => p.type === 'day')?.value);

  // Approximate UTC date at desired hour, then adjust by timezone offset
  const guessUtc = Date.UTC(year, month - 1, day, hour, 0, 0);
  const tzParts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(new Date(guessUtc));
  const tzHour = Number(tzParts.find((p) => p.type === 'hour')?.value ?? hour);
  const tzDay = Number(tzParts.find((p) => p.type === 'day')?.value ?? day);
  let diffHours = tzHour - hour;
  if (tzDay > day) diffHours += 24;
  if (tzDay < day) diffHours -= 24;
  return new Date(guessUtc - diffHours * 60 * 60 * 1000).toISOString();
}

async function handleButtonInteraction(
  interaction: Interaction
): Promise<void> {
  if (!interaction.isButton()) return;
  if (
    config.ALLOWED_DISCORD_USER_ID &&
    interaction.user.id !== config.ALLOWED_DISCORD_USER_ID
  ) {
    await interaction.reply({
      content: 'Brak uprawnień do obsługi tego asystenta.',
      ephemeral: true,
    });
    return;
  }

  const [action, targetId] = interaction.customId.split(':');
  if (!targetId) return;

  if (action === 'checkout_launch') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const updated = await launchCheckoutSessionLocal(targetId);
      await interaction.message
        .edit({ components: [buildCheckoutActionRow(updated)] })
        .catch(() => undefined);
      await interaction.editReply({
        content:
          '🖥️ Otworzono okno **Chromium (Chrome for Testing)** na komputerze z zachowanym koszykiem. Jeśli nie pojawiło się nad Operą/Discordem, kliknij ikonę Chromium na pasku zadań Windows.',
      });
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ ${err instanceof Error ? err.message : 'Nie udało się otworzyć sesji.'}`,
      });
    }
    return;
  }

  if (action === 'checkout_done' || action === 'checkout_cancel') {
    await interaction.deferReply({ ephemeral: true });
    try {
      const outcome = action === 'checkout_done' ? 'COMPLETED' : 'CANCELLED';
      const updated = await finishCheckoutSession(targetId, outcome);
      await interaction.message
        .edit({ components: [buildCheckoutActionRow(updated)] })
        .catch(() => undefined);
      await interaction.editReply({
        content:
          outcome === 'COMPLETED'
            ? '✅ Sesja oznaczona jako **Zamówione**.'
            : '❌ Sesja zakupu anulowana.',
      });
    } catch (err) {
      await interaction.editReply({
        content: `⚠️ ${err instanceof Error ? err.message : 'Błąd aktualizacji sesji.'}`,
      });
    }
    return;
  }

  const taskId = targetId;
  const task = getTaskDetail(taskId);
  if (!task) {
    await interaction.reply({
      content: 'To zadanie zostało już usunięte z tablicy.',
      ephemeral: true,
    });
    return;
  }

  if (action === 'task_done') {
    const nextStatus = task.columnStatus === 'done' ? 'ready_inbox' : 'done';
    const updated = updateTask(task.id, { columnStatus: nextStatus });
    if (updated) {
      eventBus.broadcast('task:updated', updated.id, updated);
      await refreshTaskEmbedOnDiscord(updated);
      await interaction.update({
        embeds:
          interaction.message.embeds.length > 0
            ? [buildTaskEmbed(updated)]
            : undefined,
        components: [buildTaskActionRow(updated)],
      });
      await setDiscordThreadArchived(
        updated.discordThreadId,
        nextStatus === 'done'
      );
      await interaction.followUp({
        content:
          nextStatus === 'done'
            ? '✅ Oznaczono zadanie jako **Zrobione** i zarchiwizowano wątek.'
            : '↩️ Przywrócono zadanie na tablicę.',
        ephemeral: true,
      });
    }
    return;
  }

  if (action === 'task_snooze_2h') {
    const nextReminder = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
    const updated = updateTask(task.id, {
      reminderAt: nextReminder,
      reminderSentAt: null,
      columnStatus: task.columnStatus === 'done' ? 'scheduled' : task.columnStatus,
    });
    if (updated) {
      eventBus.broadcast('task:updated', updated.id, updated);
      await refreshTaskEmbedOnDiscord(updated);
      await interaction.reply({
        content: `⏰ Przypomnienie przesunięte na **${formatDatePl(nextReminder)}**.`,
      });
    }
    return;
  }

  if (action === 'task_snooze_tomorrow') {
    const nextReminder = computeTomorrowMorningIso(config.TIMEZONE, 9);
    const updated = updateTask(task.id, {
      reminderAt: nextReminder,
      reminderSentAt: null,
      columnStatus:
        task.columnStatus === 'ready_inbox' ? 'scheduled' : task.columnStatus,
    });
    if (updated) {
      eventBus.broadcast('task:updated', updated.id, updated);
      await refreshTaskEmbedOnDiscord(updated);
      await interaction.reply({
        content: `📅 Przypomnienie ustawione na **${formatDatePl(nextReminder)}**.`,
      });
    }
    return;
  }

  if (action === 'task_rerun_research') {
    const updated = updateTask(task.id, {
      columnStatus: 'ai_processing',
      backgroundTaskType:
        task.backgroundTaskType === 'NONE'
          ? 'WEB_RESEARCH'
          : task.backgroundTaskType,
    });
    if (updated) {
      eventBus.broadcast('task:updated', updated.id, updated);
      await refreshTaskEmbedOnDiscord(updated);
      enqueueBackgroundWork(
        updated.id,
        'Przeprowadź ponowny, pogłębiony research i zaktualizuj raport.'
      );
      await interaction.reply({
        content: '🔍 Uruchamiam pogłębiony research w tle...',
      });
    }
  }
}

export async function startDiscordBot(): Promise<Client | null> {
  if (!config.discordEnabled) {
    console.log(
      '[Discord] Pominięto uruchomienie bota (brak DISCORD_BOT_TOKEN / DISCORD_INBOX_CHANNEL_ID / ALLOWED_DISCORD_USER_ID).'
    );
    return null;
  }

  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once(Events.ClientReady, (readyClient) => {
    console.log(`[Discord] Bot zalogowany jako ${readyClient.user.tag}`);
    setDiscordClient(client);
  });

  client.on(Events.MessageCreate, async (message: Message) => {
    if (message.author.bot) return;
    if (
      config.ALLOWED_DISCORD_USER_ID &&
      message.author.id !== config.ALLOWED_DISCORD_USER_ID
    ) {
      return;
    }

    try {
      // Case 1: New message in #inbox channel -> Create task or answer board query
      if (message.channelId === config.DISCORD_INBOX_CHANNEL_ID) {
        log.info('Discord', 'Nowa wiadomość na #inbox', {
          msgId: message.id,
          chars: message.content?.length ?? 0,
          attachments: message.attachments.size,
        });
        await message.react('👀').catch(() => undefined);
        await createTaskFromDiscord(message);
        return;
      }

      // Case 2: Follow-up message inside an existing task thread
      if (message.channel.isThread()) {
        const task = getTaskByDiscordThreadId(message.channelId);
        if (!task) return;
        log.info('Discord', `Nowa wiadomość w wątku "${task.title}"`, {
          threadId: message.channelId,
          chars: message.content?.length ?? 0,
        });
        await message.channel.sendTyping().catch(() => undefined);
        await handleDiscordThreadMessage(task, message);
      }
    } catch (err) {
      log.error('Discord', 'Błąd obsługi wiadomości', err);
      await message
        .reply('⚠️ Coś poszło nie tak podczas przetwarzania wiadomości. Sprawdź logi w terminalu lub `data/consiler.log`.')
        .catch(() => undefined);
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    try {
      await handleButtonInteraction(interaction);
    } catch (err) {
      log.error('Discord', 'Błąd obsługi przycisku', err);
    }
  });

  client.on(Events.ThreadDelete, async (thread) => {
    try {
      const task = getTaskByDiscordThreadId(thread.id);
      if (!task) return;
      const ok = deleteTask(task.id);
      if (ok) {
        for (const att of task.attachments) {
          const fullPath = path.resolve(
            config.uploadsDir,
            path.basename(att.filename)
          );
          await fs.unlink(fullPath).catch(() => undefined);
        }
        eventBus.broadcast('task:deleted', task.id, { id: task.id });
        log.info('Discord', `Usunięto zadanie z tablicy po usunięciu wątku: "${task.title}"`);
      }
    } catch (err) {
      log.error('Discord', 'Błąd synchronizacji ThreadDelete', err);
    }
  });

  await client.login(config.DISCORD_BOT_TOKEN);
  return client;
}
