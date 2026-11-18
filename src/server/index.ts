import fs from 'node:fs';
import path from 'node:path';
import cookieParser from 'cookie-parser';
import express from 'express';
import { config, ensureDataDirs } from './config.js';
import { initDb } from './db.js';
import { startDiscordBot } from './discord/bot.js';
import { authRouter } from './routes/auth.js';
import { checkoutRouter } from './routes/checkout.js';
import { eventsRouter } from './routes/events.js';
import { tasksRouter } from './routes/tasks.js';
import { uploadsRouter } from './routes/uploads.js';
import { startScheduler, stopScheduler } from './scheduler.js';
import { closePlaywrightBrowser } from './ai/browserVerifier.js';

async function bootstrap(): Promise<void> {
  ensureDataDirs();
  initDb();

  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use(cookieParser());

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, time: new Date().toISOString() });
  });

  app.use('/api/auth', authRouter);
  app.use('/api/checkout', checkoutRouter);
  app.use('/api/tasks', tasksRouter);
  app.use('/api/events', eventsRouter);
  app.use('/api/uploads', uploadsRouter);

  // Serve built React frontend in production (or whenever dist/web exists)
  const webDistDir = path.resolve(process.cwd(), 'dist', 'web');
  if (fs.existsSync(webDistDir)) {
    app.use(express.static(webDistDir));
    app.get('/{*splat}', (_req, res) => {
      res.sendFile(path.join(webDistDir, 'index.html'));
    });
  } else {
    app.get('/', (_req, res) => {
      res.type('text/plain').send(
        'Consiler API działa. Uruchom frontend przez `npm run dev:web` albo zbuduj go przez `npm run build`.'
      );
    });
  }

  const server = app.listen(config.PORT, () => {
    console.log(
      `[Server] Consiler działa na ${config.APP_BASE_URL} (port ${config.PORT})`
    );
  });

  startScheduler();

  const discordClient = await startDiscordBot().catch((err) => {
    console.error('[Discord] Nie udało się zalogować bota:', err);
    return null;
  });

  const shutdown = async () => {
    console.log('\n[Server] Zamykanie aplikacji...');
    stopScheduler();
    await closePlaywrightBrowser();
    if (discordClient) {
      await discordClient.destroy();
    }
    server.close(() => process.exit(0));
  };

  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());
}

bootstrap().catch((err) => {
  console.error('[Fatal]', err);
  process.exit(1);
});
