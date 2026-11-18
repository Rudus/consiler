import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { eventBus } from '../events.js';

export const eventsRouter = Router();

eventsRouter.get('/', requireAuth, (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  res.write(`event: ping\ndata: ${JSON.stringify({ ok: true })}\n\n`);
  eventBus.addSseClient(res);

  const keepAlive = setInterval(() => {
    try {
      res.write(`: keepalive\n\n`);
    } catch {
      clearInterval(keepAlive);
    }
  }, 25_000);

  req.on('close', () => {
    clearInterval(keepAlive);
  });
});
