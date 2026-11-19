import { Router } from 'express';
import { requireAuth } from '../auth.js';
import { config } from '../config.js';
import {
  getLocalDayBoundsIso,
  listCalendarEvents,
  verifyCalendarConnection,
} from '../services/googleCalendar.js';

export const calendarRouter = Router();
calendarRouter.use(requireAuth);

calendarRouter.get('/status', async (req, res) => {
  const verify = req.query.verify === '1' || req.query.verify === 'true';
  if (!verify) {
    res.json({
      enabled: config.calendarEnabled,
      calendarName: config.GOOGLE_CALENDAR_NAME,
      calendarIdConfigured: Boolean(config.GOOGLE_CALENDAR_ID.trim()),
    });
    return;
  }

  const verification = await verifyCalendarConnection();
  res.json({
    enabled: config.calendarEnabled,
    calendarName: config.GOOGLE_CALENDAR_NAME,
    calendarIdConfigured: Boolean(config.GOOGLE_CALENDAR_ID.trim()),
    verification,
  });
});

calendarRouter.get('/events', async (req, res) => {
  if (!config.calendarEnabled) {
    res.json({
      enabled: false,
      calendarName: config.GOOGLE_CALENDAR_NAME,
      events: [],
    });
    return;
  }

  const now = new Date();
  const bounds = getLocalDayBoundsIso(now, config.TIMEZONE);
  const fromParam =
    typeof req.query.from === 'string' && req.query.from.trim()
      ? req.query.from.trim()
      : bounds.startIso;

  const fromDate = new Date(fromParam);
  if (Number.isNaN(fromDate.getTime())) {
    res.status(400).json({ error: 'Nieprawidłowy parametr from.' });
    return;
  }

  const defaultTo = new Date(
    fromDate.getTime() + 14 * 24 * 60 * 60 * 1000
  ).toISOString();
  const toParam =
    typeof req.query.to === 'string' && req.query.to.trim()
      ? req.query.to.trim()
      : defaultTo;
  const toDate = new Date(toParam);
  if (Number.isNaN(toDate.getTime())) {
    res.status(400).json({ error: 'Nieprawidłowy parametr to.' });
    return;
  }

  const query =
    typeof req.query.q === 'string' && req.query.q.trim()
      ? req.query.q.trim()
      : undefined;

  try {
    const events = await listCalendarEvents({
      timeMin: fromDate.toISOString(),
      timeMax: toDate.toISOString(),
      query,
    });
    res.json({
      enabled: true,
      calendarName: config.GOOGLE_CALENDAR_NAME,
      events,
    });
  } catch (err) {
    res.status(502).json({
      error:
        err instanceof Error
          ? err.message
          : 'Nie udało się pobrać wydarzeń z Google Calendar.',
    });
  }
});
