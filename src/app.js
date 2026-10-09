import express from 'express';
import { rangeStatus } from './ranges.js';
import { webhookRouter } from './webhooks.js';

export function createApp({ pool, booking, config, log = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(webhookRouter({ pool, booking, secret: config.shopify.clientSecret, log }));

  // For uptime checks. Shows numbers left but nothing about orders or customers.
  app.get('/health', async (_req, res) => {
    try {
      const { remaining, total } = await rangeStatus(pool, config.tpc.rangeKind);
      res.json({ ok: true, mode: config.tpc.mode, rangeKind: config.tpc.rangeKind, numbersRemaining: remaining, numbersTotal: total });
    } catch (error) {
      log.error(`[health] ${error.message}`);
      res.status(503).json({ ok: false });
    }
  });

  return app;
}
