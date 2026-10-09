import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { createBookingService } from '../src/booking.js';
import { addRange } from '../src/ranges.js';
import { createTestPool, fakeShopify, makeOrder, quietLog, resetDb, startMockTpc, testConfig } from './helpers.js';

let pool;
let tpc;
before(async () => {
  pool = await createTestPool();
  tpc = await startMockTpc();
});
after(async () => {
  await tpc.close();
  await pool.end();
});
beforeEach(async () => {
  await resetDb(pool);
  tpc.bookings.clear();
  await addRange(pool, { label: 'TPC test numbers', kind: 'test', start: '5001000001', end: '5001000010' });
});

function setup({ config = testConfig(), tpcClient = tpc.client } = {}) {
  const shopify = fakeShopify();
  const booking = createBookingService({ pool, shopify, tpc: tpcClient, config, log: quietLog });
  return { shopify, booking, config };
}

async function consignment(orderId) {
  const { rows } = await pool.query(`SELECT * FROM consignments WHERE order_id = ? ORDER BY created_at, number`, [orderId]);
  return rows;
}

test('a paid order is booked with the first test number and tagged in Shopify', async () => {
  const { shopify, booking } = setup();
  const order = makeOrder();

  const result = await booking.handleWebhook('orders/paid', order);

  assert.deepEqual(result, { status: 'booked', number: '5001000001' });
  const [row] = await consignment(order.id);
  assert.equal(row.status, 'booked');
  assert.equal(row.tpc_ref_no, '2001');
  assert.equal(tpc.bookings.get('5001000001').cust_refno, String(order.id));
  assert.ok(shopify.tags.get(order.admin_graphql_api_id).has('tpc-booked'));
  assert.equal(shopify.metafields.get(order.admin_graphql_api_id).consignment_no, '5001000001');
});

test('the same order delivered twice at once is booked only once', async () => {
  const { booking } = setup();
  const order = makeOrder();

  const results = await Promise.all([
    booking.handleWebhook('orders/paid', order),
    booking.handleWebhook('orders/paid', order),
  ]);

  assert.deepEqual(results.map((r) => r.status).sort(), ['already-booked', 'booked']);
  assert.equal(tpc.bookings.size, 1);
  assert.equal((await consignment(order.id)).length, 1);
});

test('orders that fail validation use no consignment number', async () => {
  const { shopify, booking } = setup();
  const order = makeOrder();
  order.shipping_address.phone = null;

  const result = await booking.handleWebhook('orders/paid', order);

  assert.equal(result.status, 'invalid');
  assert.equal((await consignment(order.id)).length, 0);
  assert.ok(shopify.tags.get(order.admin_graphql_api_id).has('tpc-failed'));
  assert.match(shopify.metafields.get(order.admin_graphql_api_id).status, /No phone number/);

  // Staff fix the phone and add the retry tag; the order gets the first number.
  order.shipping_address.phone = '9876543210';
  const retried = await booking.handleWebhook('orders/updated', { ...order, tags: 'tpc-failed, tpc-retry' });
  assert.deepEqual(retried, { status: 'booked', number: '5001000001' });
  assert.ok(!shopify.tags.get(order.admin_graphql_api_id).has('tpc-failed'));
});

test('a number TPC already has is burned and the next one is used', async () => {
  const { booking } = setup();
  tpc.bookings.set('5001000001', { consignmentno: '5001000001' });
  const order = makeOrder();

  const result = await booking.handleWebhook('orders/paid', order);

  assert.deepEqual(result, { status: 'booked', number: '5001000002' });
  const rows = await consignment(order.id);
  assert.deepEqual(rows.map((r) => [r.number, r.status]), [['5001000001', 'burned'], ['5001000002', 'booked']]);
});

test('TPC rejecting the booking keeps the number for the retry', async () => {
  const { booking } = setup();
  const order = makeOrder();
  tpc.failNext(406, { errors: 'The ship_city field is invalid.' });

  const first = await booking.handleWebhook('orders/paid', order);
  assert.equal(first.status, 'failed');
  assert.match(first.message, /ship_city/);

  const retried = await booking.retry(order);
  assert.deepEqual(retried, { status: 'booked', number: '5001000001' });
  assert.equal((await consignment(order.id)).length, 1);
});

test('a wrong API key fails the booking with a clear message', async () => {
  const { booking } = setup();
  tpc.failNext(401, { REF_NO: '1001', REF_MESSAGE: 'Invalid API KEY. Please Contact Admin', ERROR_STATUS: 'FAILED' });

  const result = await booking.handleWebhook('orders/paid', makeOrder());
  assert.equal(result.status, 'failed');
  assert.match(result.message, /rejected the API key/);
});

test('when TPC is down the booking stays pending and is re-sent later', async () => {
  const { booking } = setup();
  const order = makeOrder();
  tpc.failNext(502);

  const first = await booking.handleWebhook('orders/paid', order);
  assert.equal(first.status, 'pending');
  assert.equal(tpc.bookings.size, 0);

  const [resent] = await booking.resendPending({ olderThanMs: 0 });
  assert.deepEqual(resent, { status: 'booked', number: '5001000001' });
  assert.equal(tpc.bookings.size, 1);
});

test('a timed-out request that actually reached TPC is recognised on the re-send', async () => {
  let calls = 0;
  const flaky = {
    async book(payload) {
      calls += 1;
      const result = await tpc.client.book(payload);
      // First call: TPC saved it, but we never saw the reply.
      return calls === 1 ? { outcome: 'unknown', message: 'timeout' } : result;
    },
  };
  const { booking } = setup({ tpcClient: flaky });
  const order = makeOrder();

  assert.equal((await booking.handleWebhook('orders/paid', order)).status, 'pending');
  const [resent] = await booking.resendPending({ olderThanMs: 0 });

  assert.deepEqual(resent, { status: 'booked', number: '5001000001' });
  const rows = await consignment(order.id);
  assert.deepEqual(rows.map((r) => r.status), ['booked']);
});

test('gives up after the maximum attempts but keeps the number', async () => {
  const { booking, shopify } = setup({ config: testConfig({ maxSendAttempts: 2 }) });
  const order = makeOrder();
  tpc.failNext(503);
  tpc.failNext(503);

  assert.equal((await booking.handleWebhook('orders/paid', order)).status, 'pending');
  const [gaveUp] = await booking.resendPending({ olderThanMs: 0 });
  assert.equal(gaveUp.status, 'failed');
  assert.match(shopify.metafields.get(order.admin_graphql_api_id).status, /did not respond after 2 attempts/);

  const retried = await booking.retry(order);
  assert.deepEqual(retried, { status: 'booked', number: '5001000001' });
});

test('fails clearly when the range is used up', async () => {
  const { booking, shopify } = setup();
  for (let i = 0; i < 10; i += 1) await booking.handleWebhook('orders/paid', makeOrder());

  const order = makeOrder();
  const result = await booking.handleWebhook('orders/paid', order);
  assert.equal(result.status, 'failed');
  assert.match(result.message, /No test consignment numbers left/);
  assert.ok(shopify.tags.get(order.admin_graphql_api_id).has('tpc-failed'));
});

test('dry-run mode never calls TPC or uses a number', async () => {
  const { booking, shopify } = setup({ config: testConfig({ tpc: { mode: 'dry-run' } }) });
  const order = makeOrder();

  const result = await booking.handleWebhook('orders/paid', order);

  assert.equal(result.status, 'dry-run');
  assert.equal(result.payload.weight, '1.000');
  assert.equal(tpc.bookings.size, 0);
  assert.equal((await consignment(order.id)).length, 0);
  assert.ok(shopify.tags.get(order.admin_graphql_api_id).has('tpc-dry-run'));
});

test('cancelled orders are skipped', async () => {
  const { booking } = setup();
  const result = await booking.handleWebhook('orders/paid', makeOrder({ cancelled_at: '2026-10-09T10:00:00Z' }));
  assert.deepEqual(result, { status: 'skipped', reason: 'order is cancelled' });
});

test('COD orders are only booked on creation when enabled', async () => {
  const cod = () => makeOrder({ financial_status: 'pending', payment_gateway_names: ['Cash on Delivery (COD)'] });

  const off = setup();
  assert.deepEqual(await off.booking.handleWebhook('orders/create', cod()), { status: 'ignored' });

  const on = setup({ config: testConfig({ bookCodOrders: true }) });
  assert.equal((await on.booking.handleWebhook('orders/create', cod())).status, 'booked');

  // Prepaid orders wait for orders/paid even with COD booking on.
  assert.deepEqual(await on.booking.handleWebhook('orders/create', makeOrder({ financial_status: 'pending' })), { status: 'ignored' });
});

test('handover tag fulfils the order with the consignment number as tracking', async () => {
  const { booking, shopify } = setup();
  const order = makeOrder();
  await booking.handleWebhook('orders/paid', order);

  const result = await booking.handleWebhook('orders/updated', { ...order, tags: 'tpc-booked, tpc-handover' });

  assert.deepEqual(result, { status: 'fulfilled', number: '5001000001' });
  const fulfil = shopify.calls.find((c) => c[0] === 'fulfil');
  assert.deepEqual(fulfil[2], {
    number: '5001000001',
    company: 'The Professional Couriers',
    url: 'https://track.example/5001000001',
    notifyCustomer: true,
  });
  assert.equal((await consignment(order.id))[0].status, 'fulfilled');
  const tags = shopify.tags.get(order.admin_graphql_api_id);
  assert.ok(tags.has('tpc-fulfilled') && !tags.has('tpc-handover'));

  // A late duplicate of the same update does nothing.
  const again = await booking.handleWebhook('orders/updated', { ...order, tags: 'tpc-booked, tpc-handover' });
  assert.equal(again.status, 'already-fulfilled');
  assert.equal(shopify.calls.filter((c) => c[0] === 'fulfil').length, 1);
});

test('handover on an order that is not booked does not fulfil', async () => {
  const { booking, shopify } = setup();
  const order = makeOrder();
  const result = await booking.handleWebhook('orders/updated', { ...order, tags: 'tpc-handover' });
  assert.equal(result.status, 'not-booked');
  assert.equal(shopify.calls.filter((c) => c[0] === 'fulfil').length, 0);
});

test('a Shopify fulfilment error leaves the order booked so staff can tag it again', async () => {
  const { booking, shopify } = setup();
  const order = makeOrder();
  await booking.handleWebhook('orders/paid', order);
  shopify.failFulfil = 'fulfillmentCreate: Fulfillment order is on hold';

  const result = await booking.handover(order);
  assert.equal(result.status, 'fulfil-failed');
  assert.equal((await consignment(order.id))[0].status, 'booked');
  assert.match(shopify.metafields.get(order.admin_graphql_api_id).status, /on hold/);

  shopify.failFulfil = null;
  assert.equal((await booking.handover(order)).status, 'fulfilled');
});

test('order updates without the app tags are ignored', async () => {
  const { booking } = setup();
  assert.deepEqual(await booking.handleWebhook('orders/updated', makeOrder({ tags: 'vip' })), { status: 'ignored' });
});
