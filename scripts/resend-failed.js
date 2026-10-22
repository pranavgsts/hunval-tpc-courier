// Usage: npm run resend-failed                         -> re-send every booking that failed because TPC couldn't be reached
//        npm run resend-failed -- TCG660014 TCG660015  -> only these
// Uses each order's stored request and its own consignment number, then updates the order in
// Shopify (tags + status) exactly as the app does. Works without Shopify's tpc-retry webhook.
// Bookings TPC rejected (bad address, wrong key...) are not touched: fix those and use tpc-retry.
import { createBookingService } from '../src/booking.js';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { createShopifyClient, createShopifyOrders } from '../src/shopify/client.js';
import { createTpcClient } from '../src/tpc/client.js';

const config = loadConfig();
if (config.tpc.mode !== 'live') {
  console.error('TPC_MODE is not live; nothing is sent to TPC in dry-run. Set TPC_MODE=live first.');
  process.exit(1);
}

const db = createPool(config.databaseUrl);
const booking = createBookingService({
  pool: db,
  shopify: createShopifyOrders(createShopifyClient(config.shopify)),
  tpc: createTpcClient(config.tpc),
  config,
});

try {
  const results = await booking.resendFailed({ numbers: process.argv.slice(2) });
  if (!results.length) console.log('Nothing to re-send: no bookings failed because TPC was unreachable.');
  for (const r of results) console.log(`${r.number ?? '?'}: ${r.status}${r.message ? ` - ${r.message}` : ''}`);
} finally {
  await db.end();
}
