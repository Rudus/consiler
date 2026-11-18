import path from 'node:path';
import fs from 'node:fs';
import {
  AttachmentBuilder,
  ChannelType,
  type Client,
  type TextChannel,
  type ThreadChannel,
} from 'discord.js';
import { config } from '../config.js';
import { addTaskMessage, updateTask } from '../db.js';
import { eventBus } from '../events.js';
import type { CheckoutSession, TaskDetail } from '../types.js';
import {
  buildCheckoutActionRow,
  buildTaskActionRow,
  buildTaskEmbed,
  chunkDiscordText,
} from './formatting.js';

let discordClient: Client | null = null;

export function setDiscordClient(client: Client | null): void {
  discordClient = client;
}

export function getDiscordClient(): Client | null {
  return discordClient;
}

async function fetchInboxChannel(): Promise<TextChannel | null> {
  if (!discordClient || !config.DISCORD_INBOX_CHANNEL_ID) return null;
  try {
    const ch = await discordClient.channels.fetch(
      config.DISCORD_INBOX_CHANNEL_ID
    );
    if (ch && ch.type === ChannelType.GuildText) {
      return ch as TextChannel;
    }
  } catch (err) {
    console.error('[Discord] Nie można pobrać kanału #inbox:', err);
  }
  return null;
}

export async function fetchTaskThread(
  threadId: string | null
): Promise<ThreadChannel | null> {
  if (!discordClient || !threadId) return null;
  try {
    const ch = await discordClient.channels.fetch(threadId);
    if (ch && ch.isThread()) {
      if (ch.archived) {
        await ch.setArchived(false).catch(() => undefined);
      }
      return ch;
    }
  } catch (err) {
    console.error(`[Discord] Nie można pobrać wątku ${threadId}:`, err);
  }
  return null;
}

/**
 * Publishes a web-created task onto Discord #inbox and opens a 1:1 thread.
 */
export async function mirrorWebTaskToDiscord(
  task: TaskDetail
): Promise<TaskDetail> {
  const inbox = await fetchInboxChannel();
  if (!inbox) return task;

  try {
    const files: AttachmentBuilder[] = [];
    for (const att of task.attachments.slice(0, 4)) {
      const fullPath = path.resolve(
        config.uploadsDir,
        path.basename(att.filename)
      );
      if (fs.existsSync(fullPath)) {
        files.push(
          new AttachmentBuilder(fullPath, { name: att.originalName })
        );
      }
    }

    const msg = await inbox.send({
      content: `🖥️ **Dodano z tablicy:** ${task.userPrompt ? `"${task.userPrompt.slice(0, 300)}"` : task.title}`,
      embeds: [buildTaskEmbed(task)],
      components: [buildTaskActionRow(task)],
      files,
    });

    const thread = await msg.startThread({
      name: task.title.slice(0, 95) || 'Zadanie',
      autoArchiveDuration: 10080, // 7 days
    });

    const updated =
      updateTask(task.id, {
        discordChannelId: inbox.id,
        discordMessageId: msg.id,
        discordThreadId: thread.id,
      }) ?? task;

    eventBus.broadcast('task:updated', updated.id, updated);
    return updated;
  } catch (err) {
    console.error('[Discord] Błąd lustra web->Discord:', err);
    return task;
  }
}

/**
 * Updates the main task card embed in Discord (either inbox message or thread starter).
 */
export async function refreshTaskEmbedOnDiscord(
  task: TaskDetail
): Promise<void> {
  if (!discordClient || !task.discordChannelId || !task.discordMessageId) {
    return;
  }
  try {
    const ch = await discordClient.channels.fetch(task.discordChannelId);
    if (!ch || !ch.isTextBased()) return;
    const msg = await ch.messages.fetch(task.discordMessageId);
    if (msg.author.id === discordClient.user?.id) {
      await msg.edit({
        embeds: [buildTaskEmbed(task)],
        components: [buildTaskActionRow(task)],
      });
    }
  } catch {
    // Message might belong to user (when created from Discord), so we update status inside thread instead
  }
}

export async function postStatusCardInThread(
  task: TaskDetail,
  heading?: string
): Promise<void> {
  const thread = await fetchTaskThread(task.discordThreadId);
  if (!thread) return;
  try {
    await thread.send({
      content: heading,
      embeds: [buildTaskEmbed(task)],
      components: [buildTaskActionRow(task)],
    });
  } catch (err) {
    console.error('[Discord] Błąd wysyłania karty statusu do wątku:', err);
  }
}

/**
 * Posts an assistant or mirrored web user message into the Discord thread and records its discordMessageId.
 */
export async function postTextToDiscordThread(params: {
  task: TaskDetail;
  text: string;
  author: 'user' | 'assistant' | 'system';
  recordInDb?: boolean;
  withActionButtons?: boolean;
}): Promise<void> {
  const { task, text, author, recordInDb = true, withActionButtons = false } =
    params;

  let dbSavedMsg = null;
  if (recordInDb) {
    dbSavedMsg = addTaskMessage({
      taskId: task.id,
      author,
      source: 'system',
      content: text,
    });
    if (dbSavedMsg) {
      eventBus.broadcast('message:created', task.id, dbSavedMsg);
    }
  }

  const thread = await fetchTaskThread(task.discordThreadId);
  if (!thread) return;

  const prefix = author === 'user' ? '💬 **[Tablica Web]:** ' : '';
  const chunks = chunkDiscordText(`${prefix}${text}`);

  try {
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;
      const sent = await thread.send({
        content: chunks[i],
        components:
          isLast && withActionButtons ? [buildTaskActionRow(task)] : undefined,
      });
      if (i === 0 && dbSavedMsg) {
        // Store first chunk's discordMessageId so Discord listener never duplicates it
        const { getDb } = await import('../db.js');
        getDb()
          .prepare(`UPDATE task_messages SET discord_message_id = ? WHERE id = ?`)
          .run(sent.id, dbSavedMsg.id);
      }
    }
  } catch (err) {
    console.error('[Discord] Błąd wysyłania wiadomości do wątku:', err);
  }
}

export async function sendDiscordReminder(task: TaskDetail): Promise<boolean> {
  const thread = await fetchTaskThread(task.discordThreadId);
  const mention = config.ALLOWED_DISCORD_USER_ID
    ? `<@${config.ALLOWED_DISCORD_USER_ID}>`
    : '@here';

  const text = `${mention} ⏰ **Przypomnienie o zadaniu:** **${task.title}**\n${task.aiSummary ? `> ${task.aiSummary.slice(0, 300)}\n` : ''}🔗 [Otwórz na tablicy](${config.APP_BASE_URL}/?task=${task.id})`;

  if (thread) {
    try {
      await thread.send({
        content: text,
        components: [buildTaskActionRow(task)],
      });
      return true;
    } catch (err) {
      console.error('[Discord] Błąd wysyłania przypomnienia w wątku:', err);
    }
  }

  const inbox = await fetchInboxChannel();
  if (inbox) {
    try {
      await inbox.send({
        content: text,
        components: [buildTaskActionRow(task)],
      });
      return true;
    } catch (err) {
      console.error('[Discord] Błąd wysyłania przypomnienia na #inbox:', err);
    }
  }
  return false;
}

export async function sendDailyDigestToInbox(text: string): Promise<void> {
  const inbox = await fetchInboxChannel();
  if (!inbox) return;
  const chunks = chunkDiscordText(text);
  for (const chunk of chunks) {
    await inbox.send({ content: chunk }).catch((err) => {
      console.error('[Discord] Błąd Daily Digest:', err);
    });
  }
}

export async function setDiscordThreadArchived(
  threadId: string | null,
  archived: boolean
): Promise<void> {
  if (!discordClient || !threadId) return;
  try {
    const ch = await discordClient.channels.fetch(threadId);
    if (ch && ch.isThread()) {
      await ch.setArchived(archived);
    }
  } catch {
    // Ignore permission or archive errors
  }
}

export async function deleteDiscordTaskResources(
  task: TaskDetail
): Promise<void> {
  if (!discordClient) return;

  if (task.discordThreadId) {
    try {
      const ch = await discordClient.channels.fetch(task.discordThreadId);
      if (ch && ch.isThread()) {
        await ch.delete('Zadanie usunięte z tablicy Consiler').catch(async () => {
          await ch
            .send('🗑️ **Zadanie zostało usunięte z tablicy webowej.**')
            .catch(() => undefined);
          await ch.setArchived(true).catch(() => undefined);
        });
      }
    } catch {
      // Thread may already be deleted
    }
  }

  if (task.discordChannelId && task.discordMessageId) {
    try {
      const ch = await discordClient.channels.fetch(task.discordChannelId);
      if (ch && ch.isTextBased()) {
        const msg = await ch.messages.fetch(task.discordMessageId);
        if (msg.author.id === discordClient.user?.id) {
          await msg.delete().catch(() => undefined);
        }
      }
    } catch {
      // Ignore if already deleted or lacking permissions
    }
  }
}

export async function postCheckoutSummaryToDiscordThread(params: {
  task: TaskDetail;
  session: CheckoutSession;
}): Promise<void> {
  const { task, session } = params;
  const lines = [
    session.status === 'READY_FOR_HANDOFF'
      ? `🛒 **Koszyk i dostawa przygotowane do przejęcia (${session.shopDomain})**`
      : `⚠️ **Wymagane dokończenie ręczne (${session.shopDomain})**`,
    session.variantNote ? `• **Wariant:** ${session.variantNote}` : '',
    session.detectedShipping ? `• **Dostawa:** ${session.detectedShipping}` : '',
    session.detectedTotal ? `• **Razem do zapłaty:** **${session.detectedTotal}**` : '',
    session.message ? `• **Info:** ${session.message}` : '',
    session.checkoutUrl ? `🔗 [Otwórz stronę kasy / koszyka](${session.checkoutUrl})` : '',
    `📋 [Otwórz w Consilerze](${config.APP_BASE_URL}/?task=${task.id})`,
  ]
    .filter(Boolean)
    .join('\n');

  const dbSaved = addTaskMessage({
    taskId: task.id,
    author: 'assistant',
    source: 'system',
    content: lines,
  });
  if (dbSaved) {
    eventBus.broadcast('message:created', task.id, dbSaved);
  }

  const thread = await fetchTaskThread(task.discordThreadId);
  if (!thread) return;

  const files: AttachmentBuilder[] = [];
  if (session.screenshotFilename) {
    const fullPath = path.resolve(
      config.uploadsDir,
      path.basename(session.screenshotFilename)
    );
    if (fs.existsSync(fullPath)) {
      files.push(
        new AttachmentBuilder(fullPath, { name: session.screenshotFilename })
      );
    }
  }

  try {
    const sent = await thread.send({
      content: lines.slice(0, 1950),
      files,
      components: [buildCheckoutActionRow(session)],
    });
    if (dbSaved) {
      const { getDb } = await import('../db.js');
      getDb()
        .prepare(`UPDATE task_messages SET discord_message_id = ? WHERE id = ?`)
        .run(sent.id, dbSaved.id);
    }
  } catch (err) {
    console.error('[Discord] Błąd wysyłania podsumowania checkoutu:', err);
  }
}
