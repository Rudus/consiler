import path from 'node:path';
import fs from 'node:fs';
import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';

export const uploadsRouter = Router();

uploadsRouter.get('/:filename', requireAuth, (req, res) => {
  const rawName = Array.isArray(req.params.filename)
    ? req.params.filename[0]
    : req.params.filename;
  const safeName = path.basename(rawName);
  const fullPath = path.resolve(config.uploadsDir, safeName);
  if (!fullPath.startsWith(config.uploadsDir) || !fs.existsSync(fullPath)) {
    res.status(404).json({ error: 'File not found' });
    return;
  }
  res.sendFile(fullPath);
});
