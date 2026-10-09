import { existsSync } from 'node:fs';

// Real environment variables win over .env, so the host's config always takes precedence.
if (existsSync('.env')) process.loadEnvFile('.env');

const env = process.env;

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes'].includes(String(value).toLowerCase());
}

function int(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

export function loadConfig(overrides = {}) {
  const config = {
    port: int(env.PORT, 3000),
    databaseUrl: env.DATABASE_URL || 'postgres://localhost:5432/tpc_courier',

    shopify: {
      shop: env.SHOPIFY_SHOP || '',
      clientId: env.SHOPIFY_CLIENT_ID || '',
      clientSecret: env.SHOPIFY_CLIENT_SECRET || '',
      apiVersion: env.SHOPIFY_API_VERSION || '2026-10',
      accessToken: env.SHOPIFY_ACCESS_TOKEN || '',
    },

    tpc: {
      mode: env.TPC_MODE === 'live' ? 'live' : 'dry-run',
      apiUrl: env.TPC_API_URL || 'http://tcg.tpctn.in/apps/api/booking',
      apiKey: env.TPC_API_KEY || '',
      apiId: env.TPC_API_ID || '',
      rangeKind: env.TPC_RANGE_KIND === 'production' ? 'production' : 'test',
      systemName: env.TPC_SYSTEM_NAME || 'Shopify',
      contentDesc: env.TPC_CONTENT_DESC || '',
      noOfPieces: int(env.TPC_NO_OF_PIECES, 1),
      packagingGrams: int(env.PACKAGING_GRAMS, 0),
      timeoutMs: int(env.TPC_TIMEOUT_MS, 20_000),
    },

    bookCodOrders: bool(env.BOOK_COD_ORDERS, false),

    fulfilment: {
      trackingCompany: env.TRACKING_COMPANY || 'The Professional Couriers',
      trackingUrlTemplate: env.TRACKING_URL_TEMPLATE || '',
      notifyCustomer: bool(env.NOTIFY_CUSTOMER_ON_FULFIL, true),
    },

    tags: {
      handover: env.TAG_HANDOVER || 'tpc-handover',
      retry: env.TAG_RETRY || 'tpc-retry',
      booked: env.TAG_BOOKED || 'tpc-booked',
      failed: env.TAG_FAILED || 'tpc-failed',
      fulfilled: env.TAG_FULFILLED || 'tpc-fulfilled',
      dryRun: env.TAG_DRY_RUN || 'tpc-dry-run',
    },

    // Numbers left (across active ranges of the current kind) at which to start warning.
    lowRangeWarnRatio: 0.1,
    // Times a booking with an unknown outcome (timeout, 5xx) is re-sent before giving up.
    maxSendAttempts: int(env.TPC_MAX_SEND_ATTEMPTS, 5),
  };

  return {
    ...config,
    ...overrides,
    shopify: { ...config.shopify, ...overrides.shopify },
    tpc: { ...config.tpc, ...overrides.tpc },
    fulfilment: { ...config.fulfilment, ...overrides.fulfilment },
    tags: { ...config.tags, ...overrides.tags },
  };
}
