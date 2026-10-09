import express from 'express';
import { rangeStatus } from './ranges.js';
import { webhookRouter } from './webhooks.js';

export function createApp({ pool, booking, config, log = console }) {
  const app = express();
  app.disable('x-powered-by');

  app.use(webhookRouter({ pool, booking, secret: config.shopify.clientSecret, log }));

  // For uptime checks. Shows numbers left but nothing about orders or customers.
  // The Dev Dashboard "App URL": what opens if someone clicks the app in the Shopify admin.
  app.get('/', (_req, res) => {
    res.type('text').send(
      `Hunval TPC courier app is running.\n\nPaid orders are booked with The Professional Courier automatically.\n`
      + `Add the tag "${config.tags.handover}" to an order when the parcel is handed over, `
      + `or "${config.tags.retry}" to retry a failed booking.\n`,
    );
  });

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
