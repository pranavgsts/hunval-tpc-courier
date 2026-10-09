import { createHmac, timingSafeEqual } from 'node:crypto';
import express from 'express';

export const WEBHOOK_TOPICS = ['orders/paid', 'orders/create', 'orders/updated'];

export function verifyShopifyHmac(rawBody, hmacHeader, secret) {
  if (!hmacHeader || !secret) return false;
  const expected = createHmac('sha256', secret).update(rawBody).digest();
  const received = Buffer.from(String(hmacHeader), 'base64');
  return received.length === expected.length && timingSafeEqual(received, expected);
}

/**
 * POST /webhooks/shopify - one endpoint for every subscribed topic.
 * Acknowledges Shopify immediately (it expects a reply within 5 seconds) and books in the background.
 */
export function webhookRouter({ pool, booking, secret, log = console }) {
  const router = express.Router();

  router.post('/webhooks/shopify', express.raw({ type: '*/*', limit: '2mb' }), async (req, res) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    if (!verifyShopifyHmac(raw, req.get('X-Shopify-Hmac-Sha256'), secret)) {
      return res.status(401).send('Invalid HMAC');
    }

    const topic = req.get('X-Shopify-Topic');
    const webhookId = req.get('X-Shopify-Webhook-Id') || req.get('X-Shopify-Event-Id');
    if (!WEBHOOK_TOPICS.includes(topic)) return res.status(200).send('Ignored');

    let order;
    try { order = JSON.parse(raw.toString('utf8')); } catch { return res.status(400).send('Bad JSON'); }

    if (webhookId) {
      const { rowCount } = await pool.query(
        'INSERT INTO webhook_events (webhook_id, topic) VALUES ($1, $2) ON CONFLICT DO NOTHING',
        [webhookId, topic],
      );
      if (rowCount === 0) return res.status(200).send('Duplicate');
    }

    res.status(200).send('OK');

    booking.handleWebhook(topic, order)
      .then((result) => {
        if (result?.status !== 'ignored') log.info(`[webhook] ${topic} ${order.name}: ${JSON.stringify(result)}`);
      })
      .catch((error) => log.error(`[webhook] ${topic} ${order.name} failed: ${error.stack || error.message}`));
  });

  return router;
}
