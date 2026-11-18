import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { Message } from 'discord.js';
import { config } from '../config.js';
import {
  addAttachment,
  addTaskMessage,
  createTask,
  getTaskDetail,
  updateTask,
} from '../db.js';
import { eventBus } from '../events.js';
import { log } from '../logger.js';
import { runTriage } from '../ai/triage.js';
import {
  answerBoardQuery,
  classifyInboxIntent,
} from '../ai/inboxRouter.js';
import { enqueueBackgroundWork } from '../ai/researchWorker.js';
import { runThreadAssistantTurn } from '../ai/threadChat.js';
import {
  mirrorWebTaskToDiscord,
  postStatusCardInThread,
  postTextToDiscordThread,
  refreshTaskEmbedOnDiscord,
} from '../discord/bridge.js';
import { chunkDiscordText, formatDatePl } from '../discord/formatting.js';
import type { TaskAttachment, TaskColumn, TaskDetail } from '../types.js';

export interface UploadedLocalFile {
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}

function determineInitialColumn(
  backgroundTaskType: string,
  dueAt: string | null,
  reminderAt: string | null
): TaskColumn {
  if (backgroundTaskType !== 'NONE') return 'ai_processing';
  if (dueAt || reminderAt) return 'scheduled';
  return 'ready_inbox';
}

function buildTriageConfirmationText(task: TaskDetail): string {
  const lines: string[] = [];
  lines.push(`📌 **Zapisano na tablicy:** ${task.title}`);
  if (task.dueAt) {
    lines.push(`📅 **Termin:** ${formatDatePl(task.dueAt)}`);
  }
  if (task.reminderAt) {
    lines.push(`⏰ **Przypomnienie:** ${formatDatePl(task.reminderAt)}`);
  }
  if (task.backgroundTaskType !== 'NONE') {
    const label =
      task.backgroundTaskType === 'WEB_RESEARCH'
        ? 'Szukam informacji w sieci i analizuję oferty...'
        : task.backgroundTaskType === 'DRAFT_CONTENT'
          ? 'Przygotowuję gotowy szkic odpowiedzi w tle...'
          : 'Rozpisuję plan działania w tle...';
    lines.push(`🤖 **Praca w tle:** ${label}`);
  }
  if (task.needsClarification && task.clarificationQuestion) {
    lines.push(`❓ **Pytanie:** ${task.clarificationQuestion}`);
  }
  lines.push(`🔗 [Otwórz kartę na tablicy](${config.APP_BASE_URL}/?task=${task.id})`);
  return lines.join('\n');
}

export async function createTaskFromWeb(
  userPrompt: string,
  files: UploadedLocalFile[]
): Promise<TaskDetail> {
  const taskId = crypto.randomUUID();
  const tempAttachments: TaskAttachment[] = files.map((f) => ({
    id: crypto.randomUUID(),
    taskId,
    filename: f.filename,
    originalName: f.originalName,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    createdAt: new Date().toISOString(),
  }));

  const triage = await runTriage(userPrompt, tempAttachments);
  const initialColumn = determineInitialColumn(
    triage.backgroundTaskType,
    triage.dueAt,
    triage.reminderAt
  );

  let task = createTask({
    id: taskId,
    title: triage.title,
    userPrompt,
    aiSummary: triage.aiSummary,
    aiReasoning: triage.aiReasoning,
    columnStatus: initialColumn,
    priority: triage.priority,
    category: triage.category,
    tags: triage.tags,
    backgroundTaskType: triage.backgroundTaskType,
    backgroundPrompt: triage.backgroundPrompt,
    dueAt: triage.dueAt,
    reminderAt: triage.reminderAt,
    needsClarification: triage.needsClarification,
    clarificationQuestion: triage.clarificationQuestion,
    checklistTexts: triage.checklist,
  });

  for (const f of files) {
    addAttachment({
      taskId: task.id,
      filename: f.filename,
      originalName: f.originalName,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
    });
  }

  if (userPrompt.trim()) {
    addTaskMessage({
      taskId: task.id,
      author: 'user',
      source: 'web',
      content: userPrompt.trim(),
    });
  }

  task = getTaskDetail(task.id)!;
  eventBus.broadcast('task:created', task.id, task);

  // Mirror 1:1 to Discord asynchronously so HTTP response stays snappy
  void (async () => {
    const mirrored = await mirrorWebTaskToDiscord(task);
    if (mirrored.discordThreadId) {
      await postTextToDiscordThread({
        task: mirrored,
        author: 'assistant',
        text: buildTriageConfirmationText(mirrored),
        recordInDb: true,
      });
    }
    if (mirrored.backgroundTaskType !== 'NONE') {
      enqueueBackgroundWork(mirrored.id);
    }
  })();

  return task;
}

export async function downloadDiscordAttachments(
  message: Message
): Promise<UploadedLocalFile[]> {
  const downloaded: UploadedLocalFile[] = [];
  for (const att of message.attachments.values()) {
    const mime = att.contentType ?? 'application/octet-stream';
    if (!mime.startsWith('image/')) continue;
    try {
      const res = await fetch(att.url);
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      const ext =
        path.extname(att.name || '') ||
        (mime === 'image/png' ? '.png' : mime === 'image/webp' ? '.webp' : '.jpg');
      const filename = `${crypto.randomUUID()}${ext}`;
      await fs.writeFile(path.join(config.uploadsDir, filename), buf);
      downloaded.push({
        filename,
        originalName: att.name || filename,
        mimeType: mime,
        sizeBytes: buf.byteLength,
      });
    } catch (err) {
      console.error('[Discord] Błąd pobierania załącznika:', err);
    }
  }
  return downloaded;
}

export async function createTaskFromDiscord(message: Message): Promise<void> {
  const userPrompt = message.content?.trim() ?? '';
  const hasImageAttachment = message.attachments.some((a) =>
    (a.contentType ?? '').startsWith('image/')
  );
  if (!userPrompt && !hasImageAttachment) return;

  // Check if the user is asking about existing tasks / board status rather than creating a new task
  const { intent, reasoning } = await classifyInboxIntent(
    userPrompt,
    hasImageAttachment
  );
  if (intent === 'BOARD_QUERY') {
    log.info('InboxRouter', `Rozpoznano zapytanie do tablicy: ${reasoning}`);
    if ('sendTyping' in message.channel) {
      await message.channel.sendTyping().catch(() => undefined);
    }
    const reply = await answerBoardQuery(userPrompt);
    const chunks = chunkDiscordText(reply);
    for (let i = 0; i < chunks.length; i++) {
      if (i === 0) {
        await message.reply(chunks[i]);
      } else if ('send' in message.channel) {
        await message.channel.send(chunks[i]);
      }
    }
    log.info('InboxRouter', `Wysłano odpowiedź na Discord (#inbox), części: ${chunks.length}`);
    return;
  }

  const files = await downloadDiscordAttachments(message);
  if (!userPrompt && files.length === 0) return;

  const taskId = crypto.randomUUID();
  const tempAttachments: TaskAttachment[] = files.map((f) => ({
    id: crypto.randomUUID(),
    taskId,
    filename: f.filename,
    originalName: f.originalName,
    mimeType: f.mimeType,
    sizeBytes: f.sizeBytes,
    createdAt: new Date().toISOString(),
  }));

  const triage = await runTriage(userPrompt, tempAttachments);
  const initialColumn = determineInitialColumn(
    triage.backgroundTaskType,
    triage.dueAt,
    triage.reminderAt
  );

  let discordThreadId: string | null = null;
  try {
    const thread = await message.startThread({
      name: triage.title.slice(0, 95) || 'Nowe zadanie',
      autoArchiveDuration: 10080,
    });
    discordThreadId = thread.id;
  } catch (err) {
    console.error('[Discord] Nie udało się utworzyć wątku:', err);
  }

  let task = createTask({
    id: taskId,
    title: triage.title,
    userPrompt,
    aiSummary: triage.aiSummary,
    aiReasoning: triage.aiReasoning,
    columnStatus: initialColumn,
    priority: triage.priority,
    category: triage.category,
    tags: triage.tags,
    backgroundTaskType: triage.backgroundTaskType,
    backgroundPrompt: triage.backgroundPrompt,
    dueAt: triage.dueAt,
    reminderAt: triage.reminderAt,
    discordChannelId: message.channelId,
    discordMessageId: message.id,
    discordThreadId,
    needsClarification: triage.needsClarification,
    clarificationQuestion: triage.clarificationQuestion,
    checklistTexts: triage.checklist,
  });

  for (const f of files) {
    addAttachment({
      taskId: task.id,
      filename: f.filename,
      originalName: f.originalName,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
    });
  }

  if (userPrompt) {
    addTaskMessage({
      taskId: task.id,
      author: 'user',
      source: 'discord',
      content: userPrompt,
      discordMessageId: message.id,
    });
  }

  task = getTaskDetail(task.id)!;
  eventBus.broadcast('task:created', task.id, task);

  await postStatusCardInThread(task, buildTriageConfirmationText(task));

  if (task.backgroundTaskType !== 'NONE') {
    enqueueBackgroundWork(task.id);
  }
}

export async function handleWebUserMessage(
  taskId: string,
  content: string
): Promise<void> {
  const task = getTaskDetail(taskId);
  if (!task) return;

  const userMsg = addTaskMessage({
    taskId,
    author: 'user',
    source: 'web',
    content,
  });
  if (userMsg) {
    eventBus.broadcast('message:created', taskId, userMsg);
  }

  // Mirror user message from Web to Discord thread
  await postTextToDiscordThread({
    task,
    text: content,
    author: 'user',
    recordInDb: false,
  });

  // Trigger AI assistant turn asynchronously
  void (async () => {
    const { reply } = await runThreadAssistantTurn(taskId, content);
    const refreshed = getTaskDetail(taskId);
    if (!refreshed) return;
    await postTextToDiscordThread({
      task: refreshed,
      text: reply,
      author: 'assistant',
      recordInDb: true,
    });
  })();
}

export async function handleDiscordThreadMessage(
  task: TaskDetail,
  message: Message
): Promise<void> {
  const content = message.content?.trim() ?? '';
  const files = await downloadDiscordAttachments(message);
  if (!content && files.length === 0) return;

  for (const f of files) {
    addAttachment({
      taskId: task.id,
      filename: f.filename,
      originalName: f.originalName,
      mimeType: f.mimeType,
      sizeBytes: f.sizeBytes,
    });
  }

  if (files.length > 0) {
    const updated = getTaskDetail(task.id);
    if (updated) eventBus.broadcast('task:updated', task.id, updated);
  }

  const textForHistory =
    content || `[Przesłano nowy zrzut ekranu: ${files.map((f) => f.originalName).join(', ')}]`;

  const saved = addTaskMessage({
    taskId: task.id,
    author: 'user',
    source: 'discord',
    content: textForHistory,
    discordMessageId: message.id,
  });

  // If duplicate discordMessageId, skip
  if (!saved) return;
  eventBus.broadcast('message:created', task.id, saved);

  // If task was waiting for clarification, clear flag when user replies
  if (task.needsClarification) {
    const updated = updateTask(task.id, {
      needsClarification: false,
      clarificationQuestion: null,
    });
    if (updated) {
      eventBus.broadcast('task:updated', updated.id, updated);
      await refreshTaskEmbedOnDiscord(updated);
    }
  }

  const { reply } = await runThreadAssistantTurn(task.id, textForHistory);
  const refreshed = getTaskDetail(task.id) ?? task;

  await postTextToDiscordThread({
    task: refreshed,
    text: reply,
    author: 'assistant',
    recordInDb: true,
  });
}
