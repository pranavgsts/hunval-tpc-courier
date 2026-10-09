import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createApp } from '../src/app.js';
import { createTestPool, makeOrder, quietLog, resetDb, testConfig } from './helpers.js';

let pool;
let server;
let baseUrl;
const handled = [];

before(async () => {
  pool = await createTestPool();
  const booking = { async handleWebhook(topic, order) { handled.push([topic, order.id]); return { status: 'booked' }; } };
  const app = createApp({ pool, booking, config: testConfig(), log: quietLog });
  server = await new Promise((resolve) => { const s = app.listen(0, () => resolve(s)); });
  baseUrl = `http://127.0.0.1:${server.address().port}`;
});
after(async () => {
  await new Promise((resolve) => server.close(resolve));
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  handled.length = 0;
});

function post(body, { topic = 'orders/paid', id = 'wh-1', secret = 'shh-secret', hmac } = {}) {
  const raw = JSON.stringify(body);
  return fetch(`${baseUrl}/webhooks/shopify`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Topic': topic,
      'X-Shopify-Webhook-Id': id,
      'X-Shopify-Hmac-Sha256': hmac ?? createHmac('sha256', secret).update(raw).digest('base64'),
    },
    body: raw,
  });
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('accepts a correctly signed webhook and hands it to booking', async () => {
  const order = makeOrder();
  const res = await post(order);
  assert.equal(res.status, 200);
  await settle();
  assert.deepEqual(handled, [['orders/paid', order.id]]);
});

test('rejects a webhook signed with the wrong secret', async () => {
  const res = await post(makeOrder(), { secret: 'wrong' });
  assert.equal(res.status, 401);
  await settle();
  assert.equal(handled.length, 0);
});

test('rejects a webhook with no signature', async () => {
  const res = await post(makeOrder(), { hmac: '' });
  assert.equal(res.status, 401);
});

test('processes a redelivered webhook only once', async () => {
  const order = makeOrder();
  await post(order, { id: 'same' });
  const second = await post(order, { id: 'same' });
  assert.equal(await second.text(), 'Duplicate');
  await settle();
  assert.equal(handled.length, 1);
});

test('ignores topics the app does not handle', async () => {
  const res = await post(makeOrder(), { topic: 'products/update' });
  assert.equal(await res.text(), 'Ignored');
  await settle();
  assert.equal(handled.length, 0);
});

test('health shows numbers left without order data', async () => {
  const res = await fetch(`${baseUrl}/health`);
  assert.deepEqual(await res.json(), { ok: true, mode: 'live', rangeKind: 'test', numbersRemaining: 0, numbersTotal: 0 });
});
