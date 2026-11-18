import crypto from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { config } from './config.js';

const COOKIE_NAME = 'consiler_session';
const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000; // 30 days

function signToken(payload: string): string {
  const hmac = crypto
    .createHmac('sha256', config.SESSION_SECRET)
    .update(payload)
    .digest('hex');
  return `${payload}.${hmac}`;
}

function verifyToken(token: string): boolean {
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  const [payload, sig] = parts;
  const expected = crypto
    .createHmac('sha256', config.SESSION_SECRET)
    .update(payload)
    .digest('hex');
  if (sig.length !== expected.length) return false;
  const validSig = crypto.timingSafeEqual(
    Buffer.from(sig, 'utf8'),
    Buffer.from(expected, 'utf8')
  );
  if (!validSig) return false;
  const expiresAt = Number(payload);
  return Number.isFinite(expiresAt) && Date.now() < expiresAt;
}

export function isAuthRequired(): boolean {
  return Boolean(config.DASHBOARD_PASSWORD.trim());
}

export function isAuthenticated(req: Request): boolean {
  if (!isAuthRequired()) return true;
  const token = req.cookies?.[COOKIE_NAME];
  if (typeof token !== 'string' || !token) return false;
  return verifyToken(token);
}

export function setSessionCookie(res: Response): void {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  const token = signToken(String(expiresAt));
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: config.APP_BASE_URL.startsWith('https://'),
    maxAge: SESSION_TTL_MS,
    path: '/',
  });
}

export function clearSessionCookie(res: Response): void {
  res.clearCookie(COOKIE_NAME, { path: '/' });
}

export function verifyPassword(password: string): boolean {
  if (!isAuthRequired()) return true;
  const a = Buffer.from(password, 'utf8');
  const b = Buffer.from(config.DASHBOARD_PASSWORD, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

export function requireAuth(
  req: Request,
  res: Response,
  next: NextFunction
): void {
  if (isAuthenticated(req)) {
    next();
    return;
  }
  res.status(401).json({ error: 'Unauthorized' });
}
