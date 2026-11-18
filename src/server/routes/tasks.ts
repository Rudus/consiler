import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import {
  addChecklistItems,
  addFishboneBone,
  addTaskArtifact,
  assignArtifactToBone,
  deleteChecklistItem,
  deleteFishboneBone,
  deleteTask,
  deleteTaskArtifact,
  deleteTaskFishbone,
  getTaskDetail,
  listTasks,
  toggleChecklistItem,
  updateFishboneMeta,
  updateTask,
} from '../db.js';
import { eventBus } from '../events.js';
import {
  advanceFishboneAiQueue,
  applyUserActionOnBone,
  executeFishboneBoneAi,
  generateFishboneForTask,
} from '../ai/fishboneAgent.js';
import { enqueueBackgroundWork } from '../ai/researchWorker.js';
import {
  deleteDiscordTaskResources,
  refreshTaskEmbedOnDiscord,
  setDiscordThreadArchived,
} from '../discord/bridge.js';
import {
  createTaskFromWeb,
  handleWebUserMessage,
  type UploadedLocalFile,
} from '../services/intake.js';

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, config.uploadsDir);
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname) || '.png';
    cb(null, `${crypto.randomUUID()}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 15 * 1024 * 1024, files: 5 },
  fileFilter: (_req, file, cb) => {
    if (file.mimetype.startsWith('image/')) {
      cb(null, true);
    } else {
      cb(new Error('Dozwolone są wyłącznie pliki graficzne (screeny).'));
    }
  },
});

export const tasksRouter = Router();
tasksRouter.use(requireAuth);

tasksRouter.get('/', (_req, res) => {
  res.json({ tasks: listTasks() });
});

tasksRouter.get('/:id', (req, res) => {
  const task = getTaskDetail(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }
  res.json({ task });
});

tasksRouter.post('/', upload.array('files', 5), async (req, res) => {
  const prompt = typeof req.body?.prompt === 'string' ? req.body.prompt : '';
  const rawFiles = (req.files as Express.Multer.File[] | undefined) ?? [];

  if (!prompt.trim() && rawFiles.length === 0) {
    res.status(400).json({ error: 'Podaj treść zadania lub załącz screena.' });
    return;
  }

  const uploaded: UploadedLocalFile[] = rawFiles.map((f) => ({
    filename: f.filename,
    originalName: f.originalname,
    mimeType: f.mimetype,
    sizeBytes: f.size,
  }));

  try {
    const task = await createTaskFromWeb(prompt, uploaded);
    res.status(201).json({ task });
  } catch (err) {
    console.error('[API] Błąd tworzenia zadania:', err);
    res.status(500).json({ error: 'Błąd tworzenia zadania.' });
  }
});

const PatchTaskSchema = z.object({
  title: z.string().min(1).max(160).optional(),
  columnStatus: z
    .enum(['ai_processing', 'ready_inbox', 'scheduled', 'done'])
    .optional(),
  priority: z.enum(['low', 'medium', 'high', 'urgent']).optional(),
  category: z.string().max(40).optional(),
  dueAt: z.string().nullable().optional(),
  reminderAt: z.string().nullable().optional(),
});

tasksRouter.patch('/:id', async (req, res) => {
  const parsed = PatchTaskSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Nieprawidłowe dane aktualizacji.' });
    return;
  }

  const prev = getTaskDetail(req.params.id);
  if (!prev) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }

  const updated = updateTask(req.params.id, parsed.data);
  if (!updated) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }

  eventBus.broadcast('task:updated', updated.id, updated);
  void refreshTaskEmbedOnDiscord(updated);

  if (
    parsed.data.columnStatus &&
    parsed.data.columnStatus !== prev.columnStatus
  ) {
    void setDiscordThreadArchived(
      updated.discordThreadId,
      parsed.data.columnStatus === 'done'
    );
  }

  res.json({ task: updated });
});

tasksRouter.delete('/:id', async (req, res) => {
  const existing = getTaskDetail(req.params.id);
  if (!existing) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }
  const ok = deleteTask(req.params.id);
  if (ok) {
    for (const att of existing.attachments) {
      const fullPath = path.resolve(
        config.uploadsDir,
        path.basename(att.filename)
      );
      await fs.unlink(fullPath).catch(() => undefined);
    }
    eventBus.broadcast('task:deleted', existing.id, { id: existing.id });
    void deleteDiscordTaskResources(existing);
  }
  res.json({ ok });
});

tasksRouter.post('/:id/messages', async (req, res) => {
  const content =
    typeof req.body?.content === 'string' ? req.body.content.trim() : '';
  if (!content) {
    res.status(400).json({ error: 'Wiadomość nie może być pusta.' });
    return;
  }
  const task = getTaskDetail(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }

  await handleWebUserMessage(task.id, content);
  res.json({ ok: true });
});

tasksRouter.post('/:id/research', (req, res) => {
  const task = getTaskDetail(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }
  const instruction =
    typeof req.body?.instruction === 'string'
      ? req.body.instruction.trim()
      : undefined;

  const updated = updateTask(task.id, {
    columnStatus: 'ai_processing',
    backgroundTaskType:
      task.backgroundTaskType === 'NONE'
        ? 'WEB_RESEARCH'
        : task.backgroundTaskType,
  });
  if (updated) {
    eventBus.broadcast('task:updated', updated.id, updated);
    void refreshTaskEmbedOnDiscord(updated);
  }

  enqueueBackgroundWork(task.id, instruction);
  res.json({ ok: true });
});

tasksRouter.post('/:id/checklist', (req, res) => {
  const text = typeof req.body?.text === 'string' ? req.body.text.trim() : '';
  if (!text) {
    res.status(400).json({ error: 'Treść podzadania nie może być pusta.' });
    return;
  }
  const task = getTaskDetail(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }

  addChecklistItems(task.id, [text]);
  const updated = getTaskDetail(task.id)!;
  eventBus.broadcast('task:updated', updated.id, updated);
  void refreshTaskEmbedOnDiscord(updated);
  res.json({ ok: true, task: updated });
});

tasksRouter.patch('/:id/checklist/:itemId', (req, res) => {
  const completed =
    typeof req.body?.completed === 'boolean' ? req.body.completed : undefined;
  const item = toggleChecklistItem(req.params.id, req.params.itemId, completed);
  if (!item) {
    res.status(404).json({ error: 'Podzadanie nie istnieje.' });
    return;
  }
  const updated = getTaskDetail(req.params.id)!;
  eventBus.broadcast('task:updated', updated.id, updated);
  void refreshTaskEmbedOnDiscord(updated);
  res.json({ ok: true, task: updated });
});

tasksRouter.delete('/:id/checklist/:itemId', (req, res) => {
  const ok = deleteChecklistItem(req.params.id, req.params.itemId);
  if (!ok) {
    res.status(404).json({ error: 'Podzadanie nie istnieje.' });
    return;
  }
  const updated = getTaskDetail(req.params.id)!;
  eventBus.broadcast('task:updated', updated.id, updated);
  res.json({ ok: true, task: updated });
});

const CreateArtifactSchema = z.object({
  type: z.enum(['link', 'message', 'note']),
  title: z.string().min(1).max(140),
  content: z.string().max(8000).default(''),
  url: z.string().url().nullable().optional(),
  boneId: z.string().nullable().optional(),
  meta: z.record(z.string()).optional(),
});

tasksRouter.post('/:id/artifacts', (req, res) => {
  const task = getTaskDetail(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }
  const parsed = CreateArtifactSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Nieprawidłowe dane artefaktu.' });
    return;
  }

  addTaskArtifact(task.id, {
    type: parsed.data.type,
    title: parsed.data.title,
    content: parsed.data.content,
    url: parsed.data.url ?? null,
    boneId: parsed.data.boneId ?? null,
    meta: parsed.data.meta ?? {},
    createdBy: 'user',
  });
  const updated = getTaskDetail(task.id)!;
  eventBus.broadcast('task:updated', updated.id, updated);
  res.status(201).json({ ok: true, task: updated });
});

tasksRouter.patch('/:id/artifacts/:artifactId', (req, res) => {
  const boneId =
    typeof req.body?.boneId === 'string' && req.body.boneId.trim()
      ? req.body.boneId.trim()
      : null;
  const updatedArt = assignArtifactToBone(
    req.params.id,
    req.params.artifactId,
    boneId
  );
  if (!updatedArt) {
    res.status(404).json({ error: 'Artefakt nie istnieje.' });
    return;
  }
  const updated = getTaskDetail(req.params.id)!;
  eventBus.broadcast('task:updated', updated.id, updated);
  res.json({ ok: true, task: updated });
});

tasksRouter.delete('/:id/artifacts/:artifactId', (req, res) => {
  const ok = deleteTaskArtifact(req.params.id, req.params.artifactId);
  if (!ok) {
    res.status(404).json({ error: 'Artefakt nie istnieje.' });
    return;
  }
  const updated = getTaskDetail(req.params.id)!;
  eventBus.broadcast('task:updated', updated.id, updated);
  res.json({ ok: true, task: updated });
});

// --- FISHBONE (Graf Rybiej Ości) ROUTES ---

tasksRouter.post('/:id/fishbone/generate', async (req, res) => {
  const task = getTaskDetail(req.params.id);
  if (!task) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }
  const customHint =
    typeof req.body?.customHint === 'string'
      ? req.body.customHint.trim()
      : undefined;
  const pinAsBigThing =
    typeof req.body?.pinAsBigThing === 'boolean'
      ? req.body.pinAsBigThing
      : undefined;

  const updated = await generateFishboneForTask(task.id, {
    customHint,
    pinAsBigThing,
    autoAdvanceAi: true,
  });
  res.json({ ok: true, task: updated });
});

const PatchFishboneMetaSchema = z.object({
  headGoal: z.string().min(1).max(200).optional(),
  tailOutcome: z.string().min(1).max(200).optional(),
  isPinnedBigThing: z.boolean().optional(),
});

tasksRouter.patch('/:id/fishbone', (req, res) => {
  const parsed = PatchFishboneMetaSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Nieprawidłowe dane rybiej ości.' });
    return;
  }
  const updated = updateFishboneMeta(req.params.id, parsed.data);
  if (!updated) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }
  // If we changed isPinnedBigThing, other tasks might have been unpinned — broadcast full update
  for (const t of listTasks()) {
    eventBus.broadcast('task:updated', t.id, t);
  }
  res.json({ ok: true, task: updated });
});

tasksRouter.delete('/:id/fishbone', (req, res) => {
  const updated = deleteTaskFishbone(req.params.id);
  if (!updated) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }
  eventBus.broadcast('task:updated', updated.id, updated);
  res.json({ ok: true, task: updated });
});

const CreateBoneSchema = z.object({
  title: z.string().min(1).max(120),
  description: z.string().max(600).default(''),
  owner: z.enum(['ai', 'user', 'shared']).default('user'),
  aiPrompt: z.string().max(1000).nullable().optional(),
  subItems: z
    .array(
      z.object({
        text: z.string().min(1).max(200),
        isOption: z.boolean().optional(),
      })
    )
    .optional(),
});

tasksRouter.post('/:id/fishbone/bones', (req, res) => {
  const parsed = CreateBoneSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Nieprawidłowe dane ości.' });
    return;
  }
  const bone = addFishboneBone(req.params.id, {
    title: parsed.data.title,
    description: parsed.data.description,
    owner: parsed.data.owner,
    status: parsed.data.owner === 'user' ? 'needs_user' : 'pending',
    aiPrompt: parsed.data.aiPrompt ?? null,
    subItems: parsed.data.subItems,
  });
  if (!bone) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }
  const updated = getTaskDetail(req.params.id)!;
  eventBus.broadcast('task:updated', updated.id, updated);
  if (parsed.data.owner === 'ai' || parsed.data.owner === 'shared') {
    void advanceFishboneAiQueue(updated.id);
  }
  res.status(201).json({ ok: true, task: updated });
});

const PatchBoneSchema = z.object({
  selectedArtifactId: z.string().nullable().optional(),
  selectSubItemId: z.string().optional(),
  toggleSubItemId: z.string().optional(),
  addSubItemText: z.string().max(200).optional(),
  status: z.enum(['pending', 'ai_working', 'needs_user', 'done']).optional(),
  owner: z.enum(['ai', 'user', 'shared']).optional(),
  title: z.string().min(1).max(120).optional(),
  description: z.string().max(600).optional(),
  aiPrompt: z.string().max(1000).nullable().optional(),
});

tasksRouter.patch('/:id/fishbone/bones/:boneId', (req, res) => {
  const parsed = PatchBoneSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Nieprawidłowe dane aktualizacji ości.' });
    return;
  }
  const result = applyUserActionOnBone(
    req.params.id,
    req.params.boneId,
    parsed.data
  );
  if (!result.task) {
    res.status(404).json({ error: 'Zadanie lub ość nie istnieje.' });
    return;
  }
  res.json({ ok: true, task: result.task });
});

tasksRouter.post('/:id/fishbone/bones/:boneId/run-ai', (req, res) => {
  const task = getTaskDetail(req.params.id);
  if (!task || !task.fishbone) {
    res.status(404).json({ error: 'Zadanie lub rybia ość nie istnieje.' });
    return;
  }
  const instruction =
    typeof req.body?.instruction === 'string' && req.body.instruction.trim()
      ? req.body.instruction.trim()
      : undefined;

  void executeFishboneBoneAi(task.id, req.params.boneId, instruction).then(
    (after) => {
      const finishedBone = after?.fishbone?.bones.find(
        (b) => b.id === req.params.boneId
      );
      if (finishedBone?.status === 'done') {
        void advanceFishboneAiQueue(task.id);
      }
    }
  );

  res.json({ ok: true });
});

tasksRouter.delete('/:id/fishbone/bones/:boneId', (req, res) => {
  const ok = deleteFishboneBone(req.params.id, req.params.boneId);
  if (!ok) {
    res.status(404).json({ error: 'Ość nie istnieje.' });
    return;
  }
  const updated = getTaskDetail(req.params.id)!;
  eventBus.broadcast('task:updated', updated.id, updated);
  res.json({ ok: true, task: updated });
});
