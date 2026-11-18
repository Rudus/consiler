import fs from 'node:fs';
import path from 'node:path';
import { config, ensureDataDirs } from './config.js';

function timestamp(): string {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: config.TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).format(new Date());
}

function appendLogLine(line: string): void {
  try {
    ensureDataDirs();
    const logPath = path.join(config.dataDir, 'consiler.log');
    fs.appendFileSync(logPath, `${new Date().toISOString()} ${line}\n`, 'utf8');
  } catch {
    // Never crash app on file log failure
  }
}

function formatMeta(meta?: unknown): string {
  if (meta === undefined) return '';
  if (meta instanceof Error) {
    return ` | ${meta.name}: ${meta.message}`;
  }
  if (typeof meta === 'string') return ` | ${meta}`;
  try {
    return ` | ${JSON.stringify(meta)}`;
  } catch {
    return '';
  }
}

export const log = {
  info(scope: string, message: string, meta?: unknown): void {
    const line = `[${timestamp()}] [${scope}] ${message}${formatMeta(meta)}`;
    console.log(line);
    appendLogLine(`INFO  ${line}`);
  },
  warn(scope: string, message: string, meta?: unknown): void {
    const line = `[${timestamp()}] [${scope}] WARN: ${message}${formatMeta(meta)}`;
    console.warn(line);
    appendLogLine(`WARN  ${line}`);
  },
  error(scope: string, message: string, err?: unknown): void {
    const detail =
      err instanceof Error
        ? `${err.name}: ${err.message}${err.stack ? `\n${err.stack}` : ''}`
        : formatMeta(err);
    const line = `[${timestamp()}] [${scope}] ERROR: ${message} ${detail}`.trim();
    console.error(line);
    appendLogLine(`ERROR ${line}`);
  },
};
