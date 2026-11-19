import path from 'node:path';
import fs from 'node:fs';
import dotenv from 'dotenv';
import { z } from 'zod';

dotenv.config();

const EnvSchema = z.object({
  GEMINI_API_KEY: z.string().default(''),
  GEMINI_TRIAGE_MODEL: z.string().default('gemini-3.8-flash'),
  GEMINI_RESEARCH_MODEL: z.string().default('gemini-3.8-flash'),

  DISCORD_BOT_TOKEN: z.string().default(''),
  DISCORD_GUILD_ID: z.string().default(''),
  DISCORD_INBOX_CHANNEL_ID: z.string().default(''),
  ALLOWED_DISCORD_USER_ID: z.string().default(''),

  PORT: z.coerce.number().int().positive().default(3000),
  APP_BASE_URL: z.string().default('http://localhost:3000'),
  DASHBOARD_PASSWORD: z.string().default(''),
  SESSION_SECRET: z.string().default('consiler-dev-secret-change-me'),

  TIMEZONE: z.string().default('Europe/Warsaw'),
  DAILY_DIGEST_CRON: z.string().default('30 8 * * *'),
  DATA_DIR: z.string().default('./data'),

  CHECKOUT_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v.toLowerCase() !== 'false' && v !== '0'),
  CHECKOUT_MAX_AMOUNT_PLN: z.coerce.number().positive().default(500),

  GOOGLE_CALENDAR_ID: z.string().default(''),
  GOOGLE_CALENDAR_NAME: z.string().default('Dom'),
  GOOGLE_SERVICE_ACCOUNT_PATH: z.string().default(''),
  GOOGLE_SERVICE_ACCOUNT_JSON: z.string().default(''),
});

const parsed = EnvSchema.parse(process.env);
const googleServiceAccountPath = parsed.GOOGLE_SERVICE_ACCOUNT_PATH.trim()
  ? path.resolve(parsed.GOOGLE_SERVICE_ACCOUNT_PATH.trim())
  : '';

export const config = {
  ...parsed,
  dataDir: path.resolve(parsed.DATA_DIR),
  uploadsDir: path.resolve(parsed.DATA_DIR, 'uploads'),
  checkoutSessionsDir: path.resolve(parsed.DATA_DIR, 'checkout_sessions'),
  checkoutProfilePath: path.resolve(parsed.DATA_DIR, 'checkout_profile.enc'),
  dbPath: path.resolve(parsed.DATA_DIR, 'consiler.db'),
  googleServiceAccountPath,
  discordEnabled: Boolean(
    parsed.DISCORD_BOT_TOKEN &&
      parsed.DISCORD_INBOX_CHANNEL_ID &&
      parsed.ALLOWED_DISCORD_USER_ID
  ),
  aiEnabled: Boolean(parsed.GEMINI_API_KEY),
  calendarEnabled: Boolean(
    parsed.GOOGLE_CALENDAR_ID.trim() &&
      (parsed.GOOGLE_SERVICE_ACCOUNT_JSON.trim() ||
        (googleServiceAccountPath && fs.existsSync(googleServiceAccountPath)))
  ),
};

export function ensureDataDirs(): void {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.uploadsDir, { recursive: true });
  fs.mkdirSync(config.checkoutSessionsDir, { recursive: true });
}
