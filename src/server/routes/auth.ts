import { Router } from 'express';
import {
  clearSessionCookie,
  isAuthRequired,
  isAuthenticated,
  setSessionCookie,
  verifyPassword,
} from '../auth.js';
import { config } from '../config.js';

export const authRouter = Router();

authRouter.get('/me', (req, res) => {
  res.json({
    authenticated: isAuthenticated(req),
    authRequired: isAuthRequired(),
    discordEnabled: config.discordEnabled,
    aiEnabled: config.aiEnabled,
    calendarEnabled: config.calendarEnabled,
    calendarName: config.GOOGLE_CALENDAR_NAME,
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
