import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import { getTaskDetail } from '../db.js';
import {
  finishCheckoutSession,
  launchCheckoutSessionLocal,
  prepareCheckoutSession,
} from '../ai/checkoutAgent.js';
import {
  getMaskedCheckoutProfile,
  saveCheckoutProfile,
} from '../services/checkoutProfile.js';

export const checkoutRouter = Router();
checkoutRouter.use(requireAuth);

const ProfileSchema = z.object({
  fullName: z.string().min(2).max(120),
  email: z.string().email().max(160),
  phone: z.string().min(6).max(32),
  street: z.string().max(180).default(''),
  postalCode: z.string().max(24).default(''),
  city: z.string().max(100).default(''),
  preferredLocker: z.string().max(80).default(''),
  notes: z.string().max(400).default(''),
});

checkoutRouter.get('/profile', async (req, res) => {
  const data = await getMaskedCheckoutProfile();
  const includePlain = req.query.edit === '1';
  res.json({
    checkoutEnabled: config.CHECKOUT_ENABLED,
    maxAmountPln: config.CHECKOUT_MAX_AMOUNT_PLN,
    configured: data.configured,
    masked: data.masked,
    profile: includePlain ? data.profile : undefined,
  });
});

checkoutRouter.put('/profile', async (req, res) => {
  const parsed = ProfileSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({
      error: 'Uzupełnij poprawnie imię i nazwisko, e-mail oraz numer telefonu.',
    });
    return;
  }
  await saveCheckoutProfile(parsed.data);
  const masked = await getMaskedCheckoutProfile();
  res.json({ ok: true, configured: masked.configured, masked: masked.masked });
});

const PrepareSchema = z.object({
  taskId: z.string().min(1),
  artifactId: z.string().nullable().optional(),
  productUrl: z.string().url().optional(),
  variantHint: z.string().max(200).optional(),
});

checkoutRouter.post('/prepare', async (req, res) => {
  const parsed = PrepareSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Nieprawidłowe dane żądania.' });
    return;
  }

  const task = getTaskDetail(parsed.data.taskId);
  if (!task) {
    res.status(404).json({ error: 'Zadanie nie istnieje.' });
    return;
  }

  let url = parsed.data.productUrl;
  if (!url && parsed.data.artifactId) {
    const art = task.artifacts.find((a) => a.id === parsed.data.artifactId);
    if (art?.url) url = art.url;
  }

  if (!url) {
    res.status(400).json({ error: 'Brak adresu URL produktu.' });
    return;
  }

  try {
    const session = await prepareCheckoutSession({
      taskId: task.id,
      artifactId: parsed.data.artifactId ?? null,
      productUrl: url,
      variantHint: parsed.data.variantHint,
    });
    res.status(201).json({ ok: true, session });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Nie udało się uruchomić sesji.',
    });
  }
});

checkoutRouter.post('/:sessionId/launch-local', async (req, res) => {
  try {
    const session = await launchCheckoutSessionLocal(req.params.sessionId);
    res.json({ ok: true, session });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Nie udało się otworzyć sesji.',
    });
  }
});

checkoutRouter.post('/:sessionId/complete', async (req, res) => {
  try {
    const session = await finishCheckoutSession(req.params.sessionId, 'COMPLETED');
    res.json({ ok: true, session });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Błąd zamykania sesji.',
    });
  }
});

checkoutRouter.post('/:sessionId/cancel', async (req, res) => {
  try {
    const session = await finishCheckoutSession(req.params.sessionId, 'CANCELLED');
    res.json({ ok: true, session });
  } catch (err) {
    res.status(400).json({
      error: err instanceof Error ? err.message : 'Błąd anulowania sesji.',
    });
  }
});
