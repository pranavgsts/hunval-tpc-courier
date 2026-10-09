import { createApp } from './app.js';
import { createBookingService } from './booking.js';
import { loadConfig } from './config.js';
import { createPool, migrate } from './db.js';
import { createShopifyClient, createShopifyOrders } from './shopify/client.js';
import { createTpcClient } from './tpc/client.js';

const RESEND_INTERVAL_MS = 5 * 60_000;

const config = loadConfig();

const missing = [['shop', 'SHOPIFY_SHOP'], ['clientSecret', 'SHOPIFY_CLIENT_SECRET']]
  .filter(([key]) => !config.shopify[key]).map(([, name]) => name);
if (missing.length) {
  throw new Error(`Missing ${missing.join(', ')}. Set it in the app's environment settings or in .env in the app folder `
    + '(see .env.example). The client secret is in the Shopify Dev Dashboard → your app → Settings.');
}
if (config.tpc.mode === 'live') {
  if (!config.tpc.apiKey || !config.tpc.apiId) throw new Error('TPC_MODE=live needs TPC_API_KEY and TPC_API_ID.');
  if (config.tpc.apiUrl.startsWith('http://') && !/localhost|127\.0\.0\.1/.test(config.tpc.apiUrl)) {
    console.warn('[tpc] TPC_API_URL is plain HTTP: the API key is sent unencrypted. Ask TPC for an HTTPS endpoint.');
  }
}

const pool = createPool(config.databaseUrl);
await migrate(pool);

const shopify = createShopifyOrders(createShopifyClient(config.shopify));
const tpc = createTpcClient(config.tpc);
const booking = createBookingService({ pool, shopify, tpc, config });

const app = createApp({ pool, booking, config });
app.listen(config.port, () => {
  console.log(`[server] Listening on :${config.port} (TPC ${config.tpc.mode}, ${config.tpc.rangeKind} numbers)`);
});

const resend = () => booking.resendPending()
  .catch((error) => console.error(`[resend] ${error.stack || error.message}`));
setTimeout(resend, 10_000);
setInterval(resend, RESEND_INTERVAL_MS);
