// Usage: npm run range:add -- <test|production> <first number> <last number> [label]
// Example: npm run range:add -- test 5001000001 5001000010 "TPC test numbers"
import { loadConfig } from '../src/config.js';
import { createPool, migrate } from '../src/db.js';
import { addRange, rangeStatus } from '../src/ranges.js';

const [kind, start, end, label] = process.argv.slice(2);
if (!['test', 'production'].includes(kind) || !start || !end) {
  console.error('Usage: npm run range:add -- <test|production> <first number> <last number> [label]');
  process.exit(1);
}

const pool = createPool(loadConfig().databaseUrl);
try {
  await migrate(pool);
  const range = await addRange(pool, { kind, start, end, label: label || `${kind} ${start}-${end}` });
  const { remaining } = await rangeStatus(pool, kind);
  console.log(`Added range #${range.id}: ${start} to ${end} (${range.end_num - range.start_num + 1} numbers).`);
  console.log(`${remaining} ${kind} numbers now available.`);
} catch (error) {
  console.error(`Could not add range: ${error.message}`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
