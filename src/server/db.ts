import crypto from 'node:crypto';
import Database from 'better-sqlite3';
import { config, ensureDataDirs } from './config.js';
import type {
  ArtifactType,
  BackgroundTaskType,
  ChecklistItem,
  CheckoutSession,
  CheckoutSessionStatus,
  FishboneBone,
  FishboneBoneStatus,
  FishboneOwner,
  FishboneSubItem,
  MessageAuthor,
  MessageSource,
  Task,
  TaskArtifact,
  TaskAttachment,
  TaskColumn,
  TaskDetail,
  TaskFishbone,
  TaskMessage,
  TaskPriority,
} from './types.js';

let dbInstance: Database.Database | null = null;

export function initDb(dbPath: string = config.dbPath): Database.Database {
  if (dbInstance) return dbInstance;
  ensureDataDirs();
  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      user_prompt TEXT NOT NULL DEFAULT '',
      ai_summary TEXT NOT NULL DEFAULT '',
      ai_reasoning TEXT NOT NULL DEFAULT '',
      column_status TEXT NOT NULL DEFAULT 'ready_inbox',
      priority TEXT NOT NULL DEFAULT 'medium',
      category TEXT NOT NULL DEFAULT 'Ogólne',
      tags_json TEXT NOT NULL DEFAULT '[]',
      background_task_type TEXT NOT NULL DEFAULT 'NONE',
      background_prompt TEXT,
      research_report TEXT,
      research_sources_json TEXT NOT NULL DEFAULT '[]',
      due_at TEXT,
      reminder_at TEXT,
      reminder_sent_at TEXT,
      discord_channel_id TEXT,
      discord_message_id TEXT,
      discord_thread_id TEXT UNIQUE,
      needs_clarification INTEGER NOT NULL DEFAULT 0,
      clarification_question TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_column ON tasks(column_status);
    CREATE INDEX IF NOT EXISTS idx_tasks_reminder ON tasks(reminder_at, reminder_sent_at);
    CREATE INDEX IF NOT EXISTS idx_tasks_thread ON tasks(discord_thread_id);

    CREATE TABLE IF NOT EXISTS checklist_items (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      text TEXT NOT NULL,
      completed INTEGER NOT NULL DEFAULT 0,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_checklist_task ON checklist_items(task_id, position);

    CREATE TABLE IF NOT EXISTS task_messages (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      author TEXT NOT NULL,
      source TEXT NOT NULL,
      content TEXT NOT NULL,
      discord_message_id TEXT UNIQUE,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_messages_task ON task_messages(task_id, created_at);

    CREATE TABLE IF NOT EXISTS task_attachments (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      filename TEXT NOT NULL,
      original_name TEXT NOT NULL,
      mime_type TEXT NOT NULL,
      size_bytes INTEGER NOT NULL,
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_attachments_task ON task_attachments(task_id);

    CREATE TABLE IF NOT EXISTS task_artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      bone_id TEXT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL DEFAULT '',
      url TEXT,
      meta_json TEXT NOT NULL DEFAULT '{}',
      created_by TEXT NOT NULL DEFAULT 'assistant',
      created_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_artifacts_task ON task_artifacts(task_id, created_at);

    CREATE TABLE IF NOT EXISTS fishbone_bones (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0,
      title TEXT NOT NULL,
      description TEXT NOT NULL DEFAULT '',
      owner TEXT NOT NULL DEFAULT 'user',
      status TEXT NOT NULL DEFAULT 'pending',
      ai_prompt TEXT,
      ai_result TEXT,
      selected_artifact_id TEXT,
      sub_items_json TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_fishbone_task ON fishbone_bones(task_id, position);

    CREATE TABLE IF NOT EXISTS checkout_sessions (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      artifact_id TEXT REFERENCES task_artifacts(id) ON DELETE SET NULL,
      shop_domain TEXT NOT NULL,
      product_url TEXT NOT NULL,
      checkout_url TEXT,
      status TEXT NOT NULL,
      variant_note TEXT,
      detected_total TEXT,
      detected_shipping TEXT,
      screenshot_filename TEXT,
      storage_state_path TEXT,
      message TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_checkout_task ON checkout_sessions(task_id, created_at);
  `);

  // Safe incremental schema migrations for existing SQLite databases
  const taskCols = new Set(
    (db.prepare(`PRAGMA table_info(tasks)`).all() as Array<{ name: string }>).map(
      (c) => c.name
    )
  );
  if (!taskCols.has('fishbone_head')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN fishbone_head TEXT`);
  }
  if (!taskCols.has('fishbone_tail')) {
    db.exec(`ALTER TABLE tasks ADD COLUMN fishbone_tail TEXT`);
  }
  if (!taskCols.has('is_pinned_big_thing')) {
    db.exec(
      `ALTER TABLE tasks ADD COLUMN is_pinned_big_thing INTEGER NOT NULL DEFAULT 0`
    );
  }

  const artifactCols = new Set(
    (
      db.prepare(`PRAGMA table_info(task_artifacts)`).all() as Array<{
        name: string;
      }>
    ).map((c) => c.name)
  );
  if (!artifactCols.has('bone_id')) {
    db.exec(`ALTER TABLE task_artifacts ADD COLUMN bone_id TEXT`);
  }

  dbInstance = db;
  return db;
}

export function getDb(): Database.Database {
  if (!dbInstance) {
    return initDb();
  }
  return dbInstance;
}

function parseJsonArray<T>(raw: string | null | undefined, fallback: T[]): T[] {
  if (!raw) return fallback;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : fallback;
  } catch {
    return fallback;
  }
}

function mapTaskRow(row: Record<string, unknown>): Task {
  return {
    id: String(row.id),
    title: String(row.title),
    userPrompt: String(row.user_prompt ?? ''),
    aiSummary: String(row.ai_summary ?? ''),
    aiReasoning: String(row.ai_reasoning ?? ''),
    columnStatus: row.column_status as TaskColumn,
    priority: row.priority as TaskPriority,
    category: String(row.category ?? 'Ogólne'),
    tags: parseJsonArray<string>(row.tags_json as string, []),
    backgroundTaskType: row.background_task_type as BackgroundTaskType,
    backgroundPrompt: (row.background_prompt as string | null) ?? null,
    researchReport: (row.research_report as string | null) ?? null,
    researchSources: parseJsonArray<{ title: string; url: string }>(
      row.research_sources_json as string,
      []
    ),
    dueAt: (row.due_at as string | null) ?? null,
    reminderAt: (row.reminder_at as string | null) ?? null,
    reminderSentAt: (row.reminder_sent_at as string | null) ?? null,
    discordChannelId: (row.discord_channel_id as string | null) ?? null,
    discordMessageId: (row.discord_message_id as string | null) ?? null,
    discordThreadId: (row.discord_thread_id as string | null) ?? null,
    needsClarification: Boolean(row.needs_clarification),
    clarificationQuestion: (row.clarification_question as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function mapChecklistRow(row: Record<string, unknown>): ChecklistItem {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    text: String(row.text),
    completed: Boolean(row.completed),
    position: Number(row.position ?? 0),
    createdAt: String(row.created_at),
  };
}

function mapMessageRow(row: Record<string, unknown>): TaskMessage {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    author: row.author as MessageAuthor,
    source: row.source as MessageSource,
    content: String(row.content),
    discordMessageId: (row.discord_message_id as string | null) ?? null,
    createdAt: String(row.created_at),
  };
}

function mapAttachmentRow(row: Record<string, unknown>): TaskAttachment {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    filename: String(row.filename),
    originalName: String(row.original_name),
    mimeType: String(row.mime_type),
    sizeBytes: Number(row.size_bytes ?? 0),
    createdAt: String(row.created_at),
  };
}

function mapArtifactRow(row: Record<string, unknown>): TaskArtifact {
  let meta: Record<string, string> = {};
  try {
    const parsed = JSON.parse(String(row.meta_json ?? '{}'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      meta = parsed as Record<string, string>;
    }
  } catch {
    meta = {};
  }
  const boneId =
    (row.bone_id as string | null) ??
    (typeof meta.boneId === 'string' && meta.boneId ? meta.boneId : null);
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    boneId,
    type: (row.type as ArtifactType) || 'note',
    title: String(row.title),
    content: String(row.content ?? ''),
    url: (row.url as string | null) ?? null,
    meta,
    createdBy: row.created_by === 'user' ? 'user' : 'assistant',
    createdAt: String(row.created_at),
  };
}

function mapFishboneBoneRow(row: Record<string, unknown>): FishboneBone {
  const subItemsRaw = parseJsonArray<Record<string, unknown>>(
    row.sub_items_json as string,
    []
  );
  const subItems: FishboneSubItem[] = subItemsRaw.map((item, idx) => ({
    id: String(item.id ?? `sub-${idx}`),
    text: String(item.text ?? ''),
    completed: Boolean(item.completed),
    isOption: Boolean(item.isOption),
    selected: Boolean(item.selected),
  }));

  return {
    id: String(row.id),
    taskId: String(row.task_id),
    position: Number(row.position ?? 0),
    title: String(row.title ?? ''),
    description: String(row.description ?? ''),
    owner: (['ai', 'user', 'shared'].includes(String(row.owner))
      ? String(row.owner)
      : 'user') as FishboneOwner,
    status: (['pending', 'ai_working', 'needs_user', 'done'].includes(
      String(row.status)
    )
      ? String(row.status)
      : 'pending') as FishboneBoneStatus,
    aiPrompt: (row.ai_prompt as string | null) ?? null,
    aiResult: (row.ai_result as string | null) ?? null,
    selectedArtifactId: (row.selected_artifact_id as string | null) ?? null,
    subItems,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

function buildTaskFishbone(
  taskRow: Record<string, unknown>,
  bones: FishboneBone[]
): TaskFishbone | null {
  const head = (taskRow.fishbone_head as string | null) ?? null;
  const tail = (taskRow.fishbone_tail as string | null) ?? null;
  const isPinned = Boolean(taskRow.is_pinned_big_thing);
  if (!head && !tail && bones.length === 0 && !isPinned) {
    return null;
  }
  return {
    headGoal: head || String(taskRow.title ?? ''),
    tailOutcome: tail || 'Problem rozwiązany i zamknięty',
    isPinnedBigThing: isPinned,
    bones,
  };
}

function mapCheckoutSessionRow(row: Record<string, unknown>): CheckoutSession {
  return {
    id: String(row.id),
    taskId: String(row.task_id),
    artifactId: (row.artifact_id as string | null) ?? null,
    shopDomain: String(row.shop_domain),
    productUrl: String(row.product_url),
    checkoutUrl: (row.checkout_url as string | null) ?? null,
    status: row.status as CheckoutSessionStatus,
    variantNote: (row.variant_note as string | null) ?? null,
    detectedTotal: (row.detected_total as string | null) ?? null,
    detectedShipping: (row.detected_shipping as string | null) ?? null,
    screenshotFilename: (row.screenshot_filename as string | null) ?? null,
    storageStatePath: (row.storage_state_path as string | null) ?? null,
    message: String(row.message ?? ''),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export interface CreateTaskInput {
  id?: string;
  title: string;
  userPrompt?: string;
  aiSummary?: string;
  aiReasoning?: string;
  columnStatus?: TaskColumn;
  priority?: TaskPriority;
  category?: string;
  tags?: string[];
  backgroundTaskType?: BackgroundTaskType;
  backgroundPrompt?: string | null;
  dueAt?: string | null;
  reminderAt?: string | null;
  discordChannelId?: string | null;
  discordMessageId?: string | null;
  discordThreadId?: string | null;
  needsClarification?: boolean;
  clarificationQuestion?: string | null;
  checklistTexts?: string[];
}

export function createTask(input: CreateTaskInput): TaskDetail {
  const db = getDb();
  const now = new Date().toISOString();
  const id = input.id ?? crypto.randomUUID();

  db.prepare(
    `INSERT INTO tasks (
      id, title, user_prompt, ai_summary, ai_reasoning, column_status,
      priority, category, tags_json, background_task_type, background_prompt,
      due_at, reminder_at, discord_channel_id, discord_message_id, discord_thread_id,
      needs_clarification, clarification_question, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.title,
    input.userPrompt ?? '',
    input.aiSummary ?? '',
    input.aiReasoning ?? '',
    input.columnStatus ?? 'ready_inbox',
    input.priority ?? 'medium',
    input.category ?? 'Ogólne',
    JSON.stringify(input.tags ?? []),
    input.backgroundTaskType ?? 'NONE',
    input.backgroundPrompt ?? null,
    input.dueAt ?? null,
    input.reminderAt ?? null,
    input.discordChannelId ?? null,
    input.discordMessageId ?? null,
    input.discordThreadId ?? null,
    input.needsClarification ? 1 : 0,
    input.clarificationQuestion ?? null,
    now,
    now
  );

  if (input.checklistTexts && input.checklistTexts.length > 0) {
    const insertItem = db.prepare(
      `INSERT INTO checklist_items (id, task_id, text, completed, position, created_at)
       VALUES (?, ?, ?, 0, ?, ?)`
    );
    input.checklistTexts.forEach((text, index) => {
      const trimmed = text.trim();
      if (trimmed) {
        insertItem.run(crypto.randomUUID(), id, trimmed, index, now);
      }
    });
  }

  return getTaskDetail(id)!;
}

export function listTasks(): TaskDetail[] {
  const db = getDb();
  const rows = db
    .prepare(`SELECT * FROM tasks ORDER BY updated_at DESC`)
    .all() as Record<string, unknown>[];

  const checklistRows = db
    .prepare(`SELECT * FROM checklist_items ORDER BY position ASC, created_at ASC`)
    .all() as Record<string, unknown>[];
  const messageRows = db
    .prepare(`SELECT * FROM task_messages ORDER BY created_at ASC`)
    .all() as Record<string, unknown>[];
  const attachmentRows = db
    .prepare(`SELECT * FROM task_attachments ORDER BY created_at ASC`)
    .all() as Record<string, unknown>[];
  const artifactRows = db
    .prepare(`SELECT * FROM task_artifacts ORDER BY created_at ASC`)
    .all() as Record<string, unknown>[];
  const checkoutRows = db
    .prepare(`SELECT * FROM checkout_sessions ORDER BY created_at DESC`)
    .all() as Record<string, unknown>[];
  const boneRows = db
    .prepare(
      `SELECT * FROM fishbone_bones ORDER BY position ASC, created_at ASC`
    )
    .all() as Record<string, unknown>[];

  const checklistByTask = new Map<string, ChecklistItem[]>();
  for (const r of checklistRows) {
    const item = mapChecklistRow(r);
    const list = checklistByTask.get(item.taskId) ?? [];
    list.push(item);
    checklistByTask.set(item.taskId, list);
  }

  const messagesByTask = new Map<string, TaskMessage[]>();
  for (const r of messageRows) {
    const msg = mapMessageRow(r);
    const list = messagesByTask.get(msg.taskId) ?? [];
    list.push(msg);
    messagesByTask.set(msg.taskId, list);
  }

  const attachmentsByTask = new Map<string, TaskAttachment[]>();
  for (const r of attachmentRows) {
    const att = mapAttachmentRow(r);
    const list = attachmentsByTask.get(att.taskId) ?? [];
    list.push(att);
    attachmentsByTask.set(att.taskId, list);
  }

  const artifactsByTask = new Map<string, TaskArtifact[]>();
  for (const r of artifactRows) {
    const art = mapArtifactRow(r);
    const list = artifactsByTask.get(art.taskId) ?? [];
    list.push(art);
    artifactsByTask.set(art.taskId, list);
  }

  const checkoutsByTask = new Map<string, CheckoutSession[]>();
  for (const r of checkoutRows) {
    const cs = mapCheckoutSessionRow(r);
    const list = checkoutsByTask.get(cs.taskId) ?? [];
    list.push(cs);
    checkoutsByTask.set(cs.taskId, list);
  }

  const bonesByTask = new Map<string, FishboneBone[]>();
  for (const r of boneRows) {
    const bone = mapFishboneBoneRow(r);
    const list = bonesByTask.get(bone.taskId) ?? [];
    list.push(bone);
    bonesByTask.set(bone.taskId, list);
  }

  return rows.map((row) => {
    const task = mapTaskRow(row);
    const bones = bonesByTask.get(task.id) ?? [];
    return {
      ...task,
      checklist: checklistByTask.get(task.id) ?? [],
      messages: messagesByTask.get(task.id) ?? [],
      attachments: attachmentsByTask.get(task.id) ?? [],
      artifacts: artifactsByTask.get(task.id) ?? [],
      checkoutSessions: checkoutsByTask.get(task.id) ?? [],
      fishbone: buildTaskFishbone(row, bones),
    };
  });
}

export function getTaskDetail(id: string): TaskDetail | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM tasks WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  if (!row) return null;

  const task = mapTaskRow(row);
  const checklist = (
    db
      .prepare(
        `SELECT * FROM checklist_items WHERE task_id = ? ORDER BY position ASC, created_at ASC`
      )
      .all(id) as Record<string, unknown>[]
  ).map(mapChecklistRow);
  const messages = (
    db
      .prepare(
        `SELECT * FROM task_messages WHERE task_id = ? ORDER BY created_at ASC`
      )
      .all(id) as Record<string, unknown>[]
  ).map(mapMessageRow);
  const attachments = (
    db
      .prepare(
        `SELECT * FROM task_attachments WHERE task_id = ? ORDER BY created_at ASC`
      )
      .all(id) as Record<string, unknown>[]
  ).map(mapAttachmentRow);
  const artifacts = (
    db
      .prepare(
        `SELECT * FROM task_artifacts WHERE task_id = ? ORDER BY created_at ASC`
      )
      .all(id) as Record<string, unknown>[]
  ).map(mapArtifactRow);
  const checkoutSessions = (
    db
      .prepare(
        `SELECT * FROM checkout_sessions WHERE task_id = ? ORDER BY created_at DESC`
      )
      .all(id) as Record<string, unknown>[]
  ).map(mapCheckoutSessionRow);
  const bones = (
    db
      .prepare(
        `SELECT * FROM fishbone_bones WHERE task_id = ? ORDER BY position ASC, created_at ASC`
      )
      .all(id) as Record<string, unknown>[]
  ).map(mapFishboneBoneRow);

  return {
    ...task,
    checklist,
    messages,
    attachments,
    artifacts,
    checkoutSessions,
    fishbone: buildTaskFishbone(row, bones),
  };
}

export function getTaskByDiscordThreadId(threadId: string): TaskDetail | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT id FROM tasks WHERE discord_thread_id = ?`)
    .get(threadId) as { id: string } | undefined;
  if (!row) return null;
  return getTaskDetail(row.id);
}

export interface UpdateTaskInput {
  title?: string;
  aiSummary?: string;
  aiReasoning?: string;
  columnStatus?: TaskColumn;
  priority?: TaskPriority;
  category?: string;
  tags?: string[];
  backgroundTaskType?: BackgroundTaskType;
  backgroundPrompt?: string | null;
  researchReport?: string | null;
  researchSources?: Array<{ title: string; url: string }>;
  dueAt?: string | null;
  reminderAt?: string | null;
  reminderSentAt?: string | null;
  discordChannelId?: string | null;
  discordMessageId?: string | null;
  discordThreadId?: string | null;
  needsClarification?: boolean;
  clarificationQuestion?: string | null;
}

export function updateTask(
  id: string,
  patch: UpdateTaskInput
): TaskDetail | null {
  const db = getDb();
  const existing = getTaskDetail(id);
  if (!existing) return null;

  const fields: string[] = [];
  const values: unknown[] = [];

  const push = (col: string, val: unknown) => {
    fields.push(`${col} = ?`);
    values.push(val);
  };

  if (patch.title !== undefined) push('title', patch.title);
  if (patch.aiSummary !== undefined) push('ai_summary', patch.aiSummary);
  if (patch.aiReasoning !== undefined) push('ai_reasoning', patch.aiReasoning);
  if (patch.columnStatus !== undefined) push('column_status', patch.columnStatus);
  if (patch.priority !== undefined) push('priority', patch.priority);
  if (patch.category !== undefined) push('category', patch.category);
  if (patch.tags !== undefined) push('tags_json', JSON.stringify(patch.tags));
  if (patch.backgroundTaskType !== undefined)
    push('background_task_type', patch.backgroundTaskType);
  if (patch.backgroundPrompt !== undefined)
    push('background_prompt', patch.backgroundPrompt);
  if (patch.researchReport !== undefined)
    push('research_report', patch.researchReport);
  if (patch.researchSources !== undefined)
    push('research_sources_json', JSON.stringify(patch.researchSources));
  if (patch.dueAt !== undefined) push('due_at', patch.dueAt);
  if (patch.reminderAt !== undefined) {
    push('reminder_at', patch.reminderAt);
    if (patch.reminderSentAt === undefined) {
      push('reminder_sent_at', null);
    }
  }
  if (patch.reminderSentAt !== undefined)
    push('reminder_sent_at', patch.reminderSentAt);
  if (patch.discordChannelId !== undefined)
    push('discord_channel_id', patch.discordChannelId);
  if (patch.discordMessageId !== undefined)
    push('discord_message_id', patch.discordMessageId);
  if (patch.discordThreadId !== undefined)
    push('discord_thread_id', patch.discordThreadId);
  if (patch.needsClarification !== undefined)
    push('needs_clarification', patch.needsClarification ? 1 : 0);
  if (patch.clarificationQuestion !== undefined)
    push('clarification_question', patch.clarificationQuestion);

  if (fields.length === 0) return existing;

  push('updated_at', new Date().toISOString());
  values.push(id);

  db.prepare(`UPDATE tasks SET ${fields.join(', ')} WHERE id = ?`).run(
    ...values
  );

  return getTaskDetail(id);
}

export function deleteTask(id: string): boolean {
  const db = getDb();
  const res = db.prepare(`DELETE FROM tasks WHERE id = ?`).run(id);
  return res.changes > 0;
}

export function addAttachment(input: {
  taskId: string;
  filename: string;
  originalName: string;
  mimeType: string;
  sizeBytes: number;
}): TaskAttachment {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO task_attachments (id, task_id, filename, original_name, mime_type, size_bytes, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.taskId,
    input.filename,
    input.originalName,
    input.mimeType,
    input.sizeBytes,
    now
  );
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, input.taskId);
  return {
    id,
    taskId: input.taskId,
    filename: input.filename,
    originalName: input.originalName,
    mimeType: input.mimeType,
    sizeBytes: input.sizeBytes,
    createdAt: now,
  };
}

export function addTaskMessage(input: {
  taskId: string;
  author: MessageAuthor;
  source: MessageSource;
  content: string;
  discordMessageId?: string | null;
}): TaskMessage | null {
  const db = getDb();
  if (input.discordMessageId) {
    const existing = db
      .prepare(`SELECT id FROM task_messages WHERE discord_message_id = ?`)
      .get(input.discordMessageId);
    if (existing) return null;
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO task_messages (id, task_id, author, source, content, discord_message_id, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.taskId,
    input.author,
    input.source,
    input.content,
    input.discordMessageId ?? null,
    now
  );
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, input.taskId);

  return {
    id,
    taskId: input.taskId,
    author: input.author,
    source: input.source,
    content: input.content,
    discordMessageId: input.discordMessageId ?? null,
    createdAt: now,
  };
}

export function addChecklistItems(taskId: string, texts: string[]): ChecklistItem[] {
  const db = getDb();
  const now = new Date().toISOString();
  const maxPosRow = db
    .prepare(
      `SELECT COALESCE(MAX(position), -1) AS max_pos FROM checklist_items WHERE task_id = ?`
    )
    .get(taskId) as { max_pos: number };
  let pos = (maxPosRow?.max_pos ?? -1) + 1;

  const insert = db.prepare(
    `INSERT INTO checklist_items (id, task_id, text, completed, position, created_at)
     VALUES (?, ?, ?, 0, ?, ?)`
  );

  const created: ChecklistItem[] = [];
  for (const raw of texts) {
    const text = raw.trim();
    if (!text) continue;
    const id = crypto.randomUUID();
    insert.run(id, taskId, text, pos, now);
    created.push({
      id,
      taskId,
      text,
      completed: false,
      position: pos,
      createdAt: now,
    });
    pos += 1;
  }
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, taskId);
  return created;
}

export function toggleChecklistItem(
  taskId: string,
  itemId: string,
  completed?: boolean
): ChecklistItem | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM checklist_items WHERE id = ? AND task_id = ?`)
    .get(itemId, taskId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const nextCompleted = completed ?? !Boolean(row.completed);
  const now = new Date().toISOString();
  db.prepare(`UPDATE checklist_items SET completed = ? WHERE id = ?`).run(
    nextCompleted ? 1 : 0,
    itemId
  );
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, taskId);

  return {
    ...mapChecklistRow(row),
    completed: nextCompleted,
  };
}

export function deleteChecklistItem(taskId: string, itemId: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`DELETE FROM checklist_items WHERE id = ? AND task_id = ?`)
    .run(itemId, taskId);
  return res.changes > 0;
}

export function getDueReminders(nowIso: string): TaskDetail[] {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT id FROM tasks
       WHERE reminder_at IS NOT NULL
         AND reminder_sent_at IS NULL
         AND reminder_at <= ?
         AND column_status != 'done'`
    )
    .all(nowIso) as { id: string }[];
  return rows
    .map((r) => getTaskDetail(r.id))
    .filter((t): t is TaskDetail => t !== null);
}

export interface CreateArtifactInput {
  type: ArtifactType;
  title: string;
  content?: string;
  url?: string | null;
  boneId?: string | null;
  meta?: Record<string, string>;
  createdBy?: 'assistant' | 'user';
}

export function addTaskArtifact(
  taskId: string,
  input: CreateArtifactInput
): TaskArtifact {
  const db = getDb();
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const boneId = input.boneId ?? null;
  const meta: Record<string, string> = { ...(input.meta ?? {}) };
  if (boneId) meta.boneId = boneId;
  const metaJson = JSON.stringify(meta);
  const createdBy = input.createdBy ?? 'assistant';

  db.prepare(
    `INSERT INTO task_artifacts (id, task_id, bone_id, type, title, content, url, meta_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    taskId,
    boneId,
    input.type,
    input.title.trim(),
    (input.content ?? '').trim(),
    input.url ?? null,
    metaJson,
    createdBy,
    now
  );
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, taskId);

  return {
    id,
    taskId,
    boneId,
    type: input.type,
    title: input.title.trim(),
    content: (input.content ?? '').trim(),
    url: input.url ?? null,
    meta,
    createdBy,
    createdAt: now,
  };
}

export function replaceAssistantArtifacts(
  taskId: string,
  items: CreateArtifactInput[]
): TaskArtifact[] {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `DELETE FROM task_artifacts WHERE task_id = ? AND created_by = 'assistant' AND bone_id IS NULL`
  ).run(taskId);

  const insert = db.prepare(
    `INSERT INTO task_artifacts (id, task_id, bone_id, type, title, content, url, meta_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assistant', ?)`
  );

  const created: TaskArtifact[] = [];
  for (const item of items) {
    const title = item.title.trim();
    if (!title) continue;
    const id = crypto.randomUUID();
    const boneId = item.boneId ?? null;
    const meta: Record<string, string> = { ...(item.meta ?? {}) };
    if (boneId) meta.boneId = boneId;
    insert.run(
      id,
      taskId,
      boneId,
      item.type,
      title,
      (item.content ?? '').trim(),
      item.url ?? null,
      JSON.stringify(meta),
      now
    );
    created.push({
      id,
      taskId,
      boneId,
      type: item.type,
      title,
      content: (item.content ?? '').trim(),
      url: item.url ?? null,
      meta,
      createdBy: 'assistant',
      createdAt: now,
    });
  }
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, taskId);
  return created;
}

export function replaceBoneAssistantArtifacts(
  taskId: string,
  boneId: string,
  items: CreateArtifactInput[]
): TaskArtifact[] {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `DELETE FROM task_artifacts WHERE task_id = ? AND bone_id = ? AND created_by = 'assistant'`
  ).run(taskId, boneId);

  const insert = db.prepare(
    `INSERT INTO task_artifacts (id, task_id, bone_id, type, title, content, url, meta_json, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'assistant', ?)`
  );

  const created: TaskArtifact[] = [];
  for (const item of items) {
    const title = item.title.trim();
    if (!title) continue;
    const id = crypto.randomUUID();
    const meta: Record<string, string> = { ...(item.meta ?? {}), boneId };
    insert.run(
      id,
      taskId,
      boneId,
      item.type,
      title,
      (item.content ?? '').trim(),
      item.url ?? null,
      JSON.stringify(meta),
      now
    );
    created.push({
      id,
      taskId,
      boneId,
      type: item.type,
      title,
      content: (item.content ?? '').trim(),
      url: item.url ?? null,
      meta,
      createdBy: 'assistant',
      createdAt: now,
    });
  }
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, taskId);
  return created;
}

export function assignArtifactToBone(
  taskId: string,
  artifactId: string,
  boneId: string | null
): TaskArtifact | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM task_artifacts WHERE id = ? AND task_id = ?`)
    .get(artifactId, taskId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const existing = mapArtifactRow(row);
  const nextMeta = { ...existing.meta };
  if (boneId) {
    nextMeta.boneId = boneId;
  } else {
    delete nextMeta.boneId;
  }
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE task_artifacts SET bone_id = ?, meta_json = ? WHERE id = ? AND task_id = ?`
  ).run(boneId, JSON.stringify(nextMeta), artifactId, taskId);
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, taskId);

  return {
    ...existing,
    boneId,
    meta: nextMeta,
  };
}

export function deleteTaskArtifact(taskId: string, artifactId: string): boolean {
  const db = getDb();
  const res = db
    .prepare(`DELETE FROM task_artifacts WHERE id = ? AND task_id = ?`)
    .run(artifactId, taskId);
  return res.changes > 0;
}

export function createCheckoutSession(input: {
  id?: string;
  taskId: string;
  artifactId?: string | null;
  shopDomain: string;
  productUrl: string;
  variantNote?: string | null;
  status?: CheckoutSessionStatus;
  message?: string;
}): CheckoutSession {
  const db = getDb();
  const id = input.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO checkout_sessions (
      id, task_id, artifact_id, shop_domain, product_url, status, variant_note, message, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    input.taskId,
    input.artifactId ?? null,
    input.shopDomain,
    input.productUrl,
    input.status ?? 'PREPARING',
    input.variantNote ?? null,
    input.message ?? '',
    now,
    now
  );
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, input.taskId);
  return getCheckoutSession(id)!;
}

export function getCheckoutSession(sessionId: string): CheckoutSession | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM checkout_sessions WHERE id = ?`)
    .get(sessionId) as Record<string, unknown> | undefined;
  return row ? mapCheckoutSessionRow(row) : null;
}

export function updateCheckoutSession(
  sessionId: string,
  patch: Partial<{
    checkoutUrl: string | null;
    status: CheckoutSessionStatus;
    variantNote: string | null;
    detectedTotal: string | null;
    detectedShipping: string | null;
    screenshotFilename: string | null;
    storageStatePath: string | null;
    message: string;
  }>
): CheckoutSession | null {
  const db = getDb();
  const existing = getCheckoutSession(sessionId);
  if (!existing) return null;

  const fields: string[] = [];
  const values: unknown[] = [];
  const push = (col: string, val: unknown) => {
    fields.push(`${col} = ?`);
    values.push(val);
  };

  if (patch.checkoutUrl !== undefined) push('checkout_url', patch.checkoutUrl);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.variantNote !== undefined) push('variant_note', patch.variantNote);
  if (patch.detectedTotal !== undefined) push('detected_total', patch.detectedTotal);
  if (patch.detectedShipping !== undefined)
    push('detected_shipping', patch.detectedShipping);
  if (patch.screenshotFilename !== undefined)
    push('screenshot_filename', patch.screenshotFilename);
  if (patch.storageStatePath !== undefined)
    push('storage_state_path', patch.storageStatePath);
  if (patch.message !== undefined) push('message', patch.message);

  if (fields.length === 0) return existing;

  const now = new Date().toISOString();
  push('updated_at', now);
  values.push(sessionId);

  db.prepare(
    `UPDATE checkout_sessions SET ${fields.join(', ')} WHERE id = ?`
  ).run(...values);
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(
    now,
    existing.taskId
  );

  return getCheckoutSession(sessionId);
}

export interface CreateFishboneBoneInput {
  id?: string;
  title: string;
  description?: string;
  owner?: FishboneOwner;
  status?: FishboneBoneStatus;
  aiPrompt?: string | null;
  aiResult?: string | null;
  selectedArtifactId?: string | null;
  subItems?: Array<{
    id?: string;
    text: string;
    completed?: boolean;
    isOption?: boolean;
    selected?: boolean;
  }>;
}

export function saveTaskFishbone(
  taskId: string,
  input: {
    headGoal: string;
    tailOutcome: string;
    isPinnedBigThing?: boolean;
    bones: CreateFishboneBoneInput[];
  }
): TaskDetail | null {
  const db = getDb();
  const existing = getTaskDetail(taskId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const isPinned =
    input.isPinnedBigThing !== undefined
      ? input.isPinnedBigThing
      : (existing.fishbone?.isPinnedBigThing ?? false);

  const tx = db.transaction(() => {
    if (isPinned) {
      db.prepare(`UPDATE tasks SET is_pinned_big_thing = 0 WHERE id != ?`).run(
        taskId
      );
    }
    db.prepare(
      `UPDATE tasks
       SET fishbone_head = ?, fishbone_tail = ?, is_pinned_big_thing = ?, updated_at = ?
       WHERE id = ?`
    ).run(
      input.headGoal.trim() || existing.title,
      input.tailOutcome.trim() || 'Problem rozwiązany i zamknięty',
      isPinned ? 1 : 0,
      now,
      taskId
    );

    db.prepare(`DELETE FROM fishbone_bones WHERE task_id = ?`).run(taskId);
    db.prepare(
      `UPDATE task_artifacts SET bone_id = NULL WHERE task_id = ?`
    ).run(taskId);

    const insertBone = db.prepare(
      `INSERT INTO fishbone_bones (
        id, task_id, position, title, description, owner, status,
        ai_prompt, ai_result, selected_artifact_id, sub_items_json, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    input.bones.forEach((b, idx) => {
      const boneId = b.id ?? crypto.randomUUID();
      const subItems: FishboneSubItem[] = (b.subItems ?? [])
        .map((s) => ({
          id: s.id ?? crypto.randomUUID(),
          text: s.text.trim(),
          completed: Boolean(s.completed),
          isOption: Boolean(s.isOption),
          selected: Boolean(s.selected),
        }))
        .filter((s) => s.text.length > 0);

      insertBone.run(
        boneId,
        taskId,
        idx,
        b.title.trim() || `Etap ${idx + 1}`,
        (b.description ?? '').trim(),
        b.owner ?? 'user',
        b.status ?? 'pending',
        b.aiPrompt ?? null,
        b.aiResult ?? null,
        b.selectedArtifactId ?? null,
        JSON.stringify(subItems),
        now,
        now
      );
    });
  });

  tx();
  return getTaskDetail(taskId);
}

export function updateFishboneMeta(
  taskId: string,
  patch: Partial<{
    headGoal: string;
    tailOutcome: string;
    isPinnedBigThing: boolean;
  }>
): TaskDetail | null {
  const db = getDb();
  const existing = getTaskDetail(taskId);
  if (!existing) return null;

  const now = new Date().toISOString();
  const head =
    patch.headGoal !== undefined
      ? patch.headGoal.trim() || existing.title
      : (existing.fishbone?.headGoal ?? existing.title);
  const tail =
    patch.tailOutcome !== undefined
      ? patch.tailOutcome.trim() || 'Problem rozwiązany i zamknięty'
      : (existing.fishbone?.tailOutcome ?? 'Problem rozwiązany i zamknięty');
  const pinned =
    patch.isPinnedBigThing !== undefined
      ? patch.isPinnedBigThing
      : (existing.fishbone?.isPinnedBigThing ?? false);

  const tx = db.transaction(() => {
    if (patch.isPinnedBigThing === true) {
      db.prepare(`UPDATE tasks SET is_pinned_big_thing = 0 WHERE id != ?`).run(
        taskId
      );
    }
    db.prepare(
      `UPDATE tasks
       SET fishbone_head = ?, fishbone_tail = ?, is_pinned_big_thing = ?, updated_at = ?
       WHERE id = ?`
    ).run(head, tail, pinned ? 1 : 0, now, taskId);
  });

  tx();
  return getTaskDetail(taskId);
}

export function addFishboneBone(
  taskId: string,
  input: CreateFishboneBoneInput
): FishboneBone | null {
  const db = getDb();
  const existing = getTaskDetail(taskId);
  if (!existing) return null;

  const now = new Date().toISOString();
  if (!existing.fishbone) {
    db.prepare(
      `UPDATE tasks SET fishbone_head = ?, fishbone_tail = ?, updated_at = ? WHERE id = ?`
    ).run(existing.title, 'Problem rozwiązany i zamknięty', now, taskId);
  }

  const maxPosRow = db
    .prepare(
      `SELECT COALESCE(MAX(position), -1) AS max_pos FROM fishbone_bones WHERE task_id = ?`
    )
    .get(taskId) as { max_pos: number };
  const pos = (maxPosRow?.max_pos ?? -1) + 1;
  const id = input.id ?? crypto.randomUUID();
  const subItems: FishboneSubItem[] = (input.subItems ?? [])
    .map((s) => ({
      id: s.id ?? crypto.randomUUID(),
      text: s.text.trim(),
      completed: Boolean(s.completed),
      isOption: Boolean(s.isOption),
      selected: Boolean(s.selected),
    }))
    .filter((s) => s.text.length > 0);

  db.prepare(
    `INSERT INTO fishbone_bones (
      id, task_id, position, title, description, owner, status,
      ai_prompt, ai_result, selected_artifact_id, sub_items_json, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    taskId,
    pos,
    input.title.trim() || `Etap ${pos + 1}`,
    (input.description ?? '').trim(),
    input.owner ?? 'user',
    input.status ?? 'pending',
    input.aiPrompt ?? null,
    input.aiResult ?? null,
    input.selectedArtifactId ?? null,
    JSON.stringify(subItems),
    now,
    now
  );
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, taskId);

  const row = db
    .prepare(`SELECT * FROM fishbone_bones WHERE id = ?`)
    .get(id) as Record<string, unknown> | undefined;
  return row ? mapFishboneBoneRow(row) : null;
}

export function updateFishboneBone(
  taskId: string,
  boneId: string,
  patch: Partial<{
    title: string;
    description: string;
    owner: FishboneOwner;
    status: FishboneBoneStatus;
    aiPrompt: string | null;
    aiResult: string | null;
    selectedArtifactId: string | null;
    subItems: FishboneSubItem[];
  }>
): FishboneBone | null {
  const db = getDb();
  const row = db
    .prepare(`SELECT * FROM fishbone_bones WHERE id = ? AND task_id = ?`)
    .get(boneId, taskId) as Record<string, unknown> | undefined;
  if (!row) return null;

  const fields: string[] = [];
  const values: unknown[] = [];
  const push = (col: string, val: unknown) => {
    fields.push(`${col} = ?`);
    values.push(val);
  };

  if (patch.title !== undefined) push('title', patch.title.trim());
  if (patch.description !== undefined)
    push('description', patch.description.trim());
  if (patch.owner !== undefined) push('owner', patch.owner);
  if (patch.status !== undefined) push('status', patch.status);
  if (patch.aiPrompt !== undefined) push('ai_prompt', patch.aiPrompt);
  if (patch.aiResult !== undefined) push('ai_result', patch.aiResult);
  if (patch.selectedArtifactId !== undefined)
    push('selected_artifact_id', patch.selectedArtifactId);
  if (patch.subItems !== undefined)
    push('sub_items_json', JSON.stringify(patch.subItems));

  if (fields.length === 0) return mapFishboneBoneRow(row);

  const now = new Date().toISOString();
  push('updated_at', now);
  values.push(boneId, taskId);

  db.prepare(
    `UPDATE fishbone_bones SET ${fields.join(', ')} WHERE id = ? AND task_id = ?`
  ).run(...values);
  db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, taskId);

  const updated = db
    .prepare(`SELECT * FROM fishbone_bones WHERE id = ? AND task_id = ?`)
    .get(boneId, taskId) as Record<string, unknown> | undefined;
  return updated ? mapFishboneBoneRow(updated) : null;
}

export function deleteFishboneBone(taskId: string, boneId: string): boolean {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE task_artifacts SET bone_id = NULL WHERE task_id = ? AND bone_id = ?`
  ).run(taskId, boneId);
  const res = db
    .prepare(`DELETE FROM fishbone_bones WHERE id = ? AND task_id = ?`)
    .run(boneId, taskId);
  if (res.changes > 0) {
    db.prepare(`UPDATE tasks SET updated_at = ? WHERE id = ?`).run(now, taskId);
    return true;
  }
  return false;
}

export function deleteTaskFishbone(taskId: string): TaskDetail | null {
  const db = getDb();
  const now = new Date().toISOString();
  db.prepare(
    `UPDATE task_artifacts SET bone_id = NULL WHERE task_id = ?`
  ).run(taskId);
  db.prepare(`DELETE FROM fishbone_bones WHERE task_id = ?`).run(taskId);
  db.prepare(
    `UPDATE tasks SET fishbone_head = NULL, fishbone_tail = NULL, is_pinned_big_thing = 0, updated_at = ? WHERE id = ?`
  ).run(now, taskId);
  return getTaskDetail(taskId);
}
