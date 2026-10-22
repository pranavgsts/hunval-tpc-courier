// Usage: npm run diagnose                -> list bookings that are failed or still pending
//        npm run diagnose -- TCG660014   -> re-send that stored booking once and print everything
// Sends exactly what the app sends and shows TPC's full reply, or the full network error.
// It does not change the database: if TPC accepts it, add the tpc-retry tag to the order so the
// app records it (TPC's "already exists" reply then marks the order booked).
import { lookup } from 'node:dns/promises';
import { loadConfig } from '../src/config.js';
import { createPool } from '../src/db.js';
import { classify } from '../src/tpc/client.js';

const config = loadConfig();
const db = createPool(config.databaseUrl);
const number = process.argv[2];

function describeError(error) {
  const lines = [];
  for (let e = error, depth = 0; e && depth < 5; e = e.cause, depth += 1) {
    const details = ['code', 'errno', 'syscall', 'address', 'port'].filter((k) => e[k] !== undefined)
      .map((k) => `${k}=${e[k]}`).join(' ');
    lines.push(`${'  '.repeat(depth)}${e.name ?? 'Error'}: ${e.message}${details ? ` [${details}]` : ''}`);
  }
  return lines.join('\n');
}

try {
  if (!number) {
    const { rows } = await db.query(
      `SELECT number, order_name, status, attempts, last_error, updated_at FROM consignments
        WHERE status IN ('failed', 'reserved') ORDER BY updated_at DESC LIMIT 50`);
    if (!rows.length) console.log('No failed or pending bookings.');
    for (const r of rows) {
      console.log(`${r.number}  ${r.order_name}  ${r.status}  attempts=${r.attempts}  ${r.updated_at.toISOString()}\n    ${r.last_error ?? ''}`);
    }
    process.exit(0);
  }

  const { rows } = await db.query('SELECT * FROM consignments WHERE number = ?', [number]);
  const row = rows[0];
  if (!row) throw new Error(`No booking with consignment ${number}.`);
  const payload = typeof row.payload === 'string' ? JSON.parse(row.payload) : row.payload;
  console.log(`Order ${row.order_name}  status=${row.status}  attempts=${row.attempts}`);
  console.log(`Last error: ${row.last_error ?? '-'}`);
  if (!payload) throw new Error('No stored request for this booking (it never reached the send step). Use the tpc-retry tag instead.');
  console.log('Request fields:', JSON.stringify(payload, null, 2));

  const url = new URL(config.tpc.apiUrl);
  console.log(`\nNode ${process.version}  ->  ${url.href}`);
  console.log('DNS:', JSON.stringify(await lookup(url.hostname, { all: true }).catch((e) => e.message)));

  const form = new FormData();
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null && value !== '') form.append(key, String(value));
  }
  const started = Date.now();
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'X-Api-Key': config.tpc.apiKey, 'X-Api-Id': String(config.tpc.apiId) },
      body: form,
      signal: AbortSignal.timeout(config.tpc.timeoutMs),
    });
    const text = await response.text();
    console.log(`\nHTTP ${response.status} after ${Date.now() - started} ms`);
    console.log(`Content-Type: ${response.headers.get('content-type')}`);
    console.log(`Body: ${text.replace(/\s+/g, ' ').slice(0, 1500)}`);
    let body;
    try { body = JSON.parse(text); } catch { body = { raw: text.slice(0, 500) }; }
    const result = classify(response.status, body);
    console.log(`\nApp would record: ${result.outcome} - ${result.message}`);
    if (['booked', 'duplicate'].includes(result.outcome)) {
      console.log('TPC has this booking now. Add the tag tpc-retry to the order so the app records it as booked.');
    }
  } catch (error) {
    console.log(`\nNETWORK FAILURE after ${Date.now() - started} ms:\n${describeError(error)}`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  await db.end();
}
