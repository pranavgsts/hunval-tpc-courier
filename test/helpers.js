import pg from 'pg';
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { createMockTpcApp } from '../src/tpc/mock-server.js';
import { createTpcClient } from '../src/tpc/client.js';

const TEST_DB = process.env.TEST_DATABASE_URL || 'postgres://localhost:5432/tpc_courier_test';

export async function createTestPool() {
  const url = new URL(TEST_DB);
  const dbName = url.pathname.slice(1);
  const admin = new pg.Client({ connectionString: Object.assign(new URL(TEST_DB), { pathname: '/postgres' }).toString() });
  await admin.connect();
  const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [dbName]);
  if (!rowCount) await admin.query(`CREATE DATABASE "${dbName}"`);
  await admin.end();

  const pool = createPool(TEST_DB);
  await migrate(pool);
  return pool;
}

export async function resetDb(pool) {
  await pool.query('TRUNCATE consignments, consignment_ranges, webhook_events RESTART IDENTITY CASCADE');
}

export function testConfig(overrides = {}) {
  return loadConfig({
    ...overrides,
    shopify: { shop: 'test-shop', clientSecret: 'shh-secret', ...overrides.shopify },
    tpc: {
      mode: 'live', apiKey: 'test-key', apiId: '1', rangeKind: 'test',
      systemName: 'Shopify', contentDesc: 'Apparel', noOfPieces: 1, packagingGrams: 100, timeoutMs: 2000,
      ...overrides.tpc,
    },
    fulfilment: { trackingCompany: 'The Professional Couriers', trackingUrlTemplate: 'https://track.example/{number}', notifyCustomer: true, ...overrides.fulfilment },
    maxSendAttempts: overrides.maxSendAttempts ?? 3,
  });
}

export async function startMockTpc() {
  const mock = createMockTpcApp({ apiKey: 'test-key', apiId: '1' });
  const server = await new Promise((resolve) => {
    const s = mock.app.listen(0, () => resolve(s));
  });
  const url = `http://127.0.0.1:${server.address().port}/apps/api/booking`;
  return {
    ...mock,
    url,
    client: createTpcClient({ apiUrl: url, apiKey: 'test-key', apiId: '1', timeoutMs: 2000 }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** Records what the app would have done in Shopify. */
export function fakeShopify() {
  const calls = [];
  const tags = new Map();
  const metafields = new Map();
  return {
    calls,
    tags,
    metafields,
    failFulfil: null,
    async addTags(gid, list) {
      calls.push(['addTags', gid, list]);
      tags.set(gid, new Set([...(tags.get(gid) ?? []), ...list]));
    },
    async removeTags(gid, list) {
      calls.push(['removeTags', gid, list]);
      const set = tags.get(gid) ?? new Set();
      for (const t of list) set.delete(t);
      tags.set(gid, set);
    },
    async setMetafields(gid, values) {
      calls.push(['setMetafields', gid, values]);
      metafields.set(gid, { ...metafields.get(gid), ...values });
    },
    async fulfil(gid, tracking) {
      calls.push(['fulfil', gid, tracking]);
      if (this.failFulfil) throw new Error(this.failFulfil);
      return 1;
    },
  };
}

export const quietLog = { info() {}, warn() {}, error() {} };

let nextOrderId = 1000;
export function makeOrder(overrides = {}) {
  const id = overrides.id ?? nextOrderId++;
  return {
    id,
    admin_graphql_api_id: `gid://shopify/Order/${id}`,
    name: `#${id}`,
    financial_status: 'paid',
    cancelled_at: null,
    fulfillment_status: null,
    tags: '',
    phone: null,
    total_weight: 900,
    current_subtotal_price: '1499.00',
    payment_gateway_names: ['razorpay'],
    line_items: [
      { title: 'Cotton Kurta', grams: 450, quantity: 2, requires_shipping: true },
    ],
    shipping_address: {
      name: 'Priya Raman',
      company: null,
      address1: '12, Gandhi Street',
      address2: 'Near Bus Stand',
      city: 'Tiruchengode',
      province: 'Tamil Nadu',
      zip: '637211',
      phone: '+91 98765 43210',
      country_code: 'IN',
    },
    ...overrides,
  };
}
