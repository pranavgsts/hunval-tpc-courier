// Usage: npm run range:status [-- test|production]
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { rangeStatus } from '../src/ranges.js';

const kind = process.argv[2];
const pool = createPool(loadConfig().databaseUrl);
try {
  await migrate(pool);
  const { ranges, remaining, total } = await rangeStatus(pool, kind);
  if (!ranges.length) console.log('No ranges yet. Add one with npm run range:add.');
  for (const r of ranges) {
    console.log(`#${r.id} ${r.kind.padEnd(10)} ${r.label}  remaining ${r.remaining}/${r.total}  next ${r.next ?? '(used up)'}${r.active ? '' : '  [inactive]'}`);
  }
  console.log(`Active total: ${remaining} of ${total} left.`);

  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS n FROM consignments GROUP BY status ORDER BY status`);
  if (rows.length) console.log(`Consignments: ${rows.map((r) => `${r.status} ${r.n}`).join(', ')}`);
} finally {
  await pool.end();
}
