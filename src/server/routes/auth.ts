import fs from 'node:fs';
import path from 'node:path';
import { Router } from 'express';
import {
  clearSessionCookie,
  isAuthRequired,
  isAuthenticated,
  requireAuth,
  setSessionCookie,
  verifyPassword,
} from '../auth.js';
import { config, ensureDataDirs } from '../config.js';
import { closeDb, initDb } from '../db.js';

export const authRouter = Router();

authRouter.get('/me', (req, res) => {
  res.json({
    authenticated: isAuthenticated(req),
    authRequired: isAuthRequired(),
    discordEnabled: config.discordEnabled,
    aiEnabled: config.aiEnabled,
    timezone: config.TIMEZONE,
  });
});

authRouter.post('/login', (req, res) => {
  const password =
    typeof req.body?.password === 'string' ? req.body.password : '';
  if (!verifyPassword(password)) {
    res.status(401).json({ error: 'Nieprawidłowe hasło.' });
    return;
  }
  setSessionCookie(res);
  res.json({ ok: true });
});

authRouter.post('/logout', (_req, res) => {
  clearSessionCookie(res);
  res.json({ ok: true });
});

authRouter.post('/import-file', requireAuth, (req, res) => {
  const relPath = typeof req.body?.relPath === 'string' ? req.body.relPath : '';
  const dataBase64 =
    typeof req.body?.dataBase64 === 'string' ? req.body.dataBase64 : '';
  if (!relPath || !dataBase64) {
    res.status(400).json({ error: 'Missing relPath or dataBase64' });
    return;
  }
  ensureDataDirs();
  const targetPath = path.resolve(config.dataDir, relPath);
  if (!targetPath.startsWith(config.dataDir)) {
    res.status(400).json({ error: 'Invalid path' });
    return;
  }
  const isDb = path.basename(targetPath) === 'consiler.db';
  if (isDb) {
    closeDb();
    for (const ext of ['-wal', '-shm']) {
      const aux = `${targetPath}${ext}`;
      if (fs.existsSync(aux)) {
        fs.unlinkSync(aux);
      }
    }
  }
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, Buffer.from(dataBase64, 'base64'));
  if (isDb) {
    initDb();
  }
  res.json({ ok: true, relPath });
});
