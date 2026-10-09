import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { withTransaction } from '../src/db.js';
import { addRange, allocateNumber, parseRange, rangeStatus } from '../src/ranges.js';
import { createTestPool, resetDb } from './helpers.js';

let pool;
before(async () => { pool = await createTestPool(); });
after(async () => { await pool.end(); });
beforeEach(async () => { await resetDb(pool); });

const allocate = (orderId) => withTransaction(pool, (client) =>
  allocateNumber(client, 'test', { id: orderId, gid: `gid://shopify/Order/${orderId}`, name: `#${orderId}` }));

test('parseRange keeps prefix and leading zeros', () => {
  assert.deepEqual(parseRange('TCG000001', 'TCG000500'), { prefix: 'TCG', width: 6, start_num: 1, end_num: 500 });
  assert.deepEqual(parseRange('5001000001', '5001000010'), { prefix: '', width: 10, start_num: 5001000001, end_num: 5001000010 });
});

test('parseRange rejects bad ranges', () => {
  assert.throws(() => parseRange('A0001', 'B0009'), /different prefixes/);
  assert.throws(() => parseRange('0001', '00009'), /same number of digits/);
  assert.throws(() => parseRange('0009', '0001'), /End is before start/);
  assert.throws(() => parseRange('0001', '0009'), /must be 5-15 characters/);
  assert.throws(() => parseRange('1234567890123456', '1234567890123459'), /must be 5-15 characters|too large/);
});

test('allocates numbers in order and stops when the range is used up', async () => {
  await addRange(pool, { label: 'tpc test', kind: 'test', start: '5001000001', end: '5001000003' });
  const got = [];
  for (let i = 1; i <= 4; i += 1) got.push((await allocate(i))?.number ?? null);
  assert.deepEqual(got, ['5001000001', '5001000002', '5001000003', null]);
});

test('moves on to the next range when one runs out', async () => {
  await addRange(pool, { label: 'first', kind: 'test', start: 'TCG00001', end: 'TCG00001' });
  await addRange(pool, { label: 'second', kind: 'test', start: 'TCG00500', end: 'TCG00501' });
  assert.equal((await allocate(1)).number, 'TCG00001');
  assert.equal((await allocate(2)).number, 'TCG00500');
});

test('never draws production numbers when test is selected', async () => {
  await addRange(pool, { label: 'prod', kind: 'production', start: '7000000001', end: '7000000100' });
  assert.equal(await allocate(1), null);
});

test('concurrent allocations never share a number', async () => {
  await addRange(pool, { label: 'tpc test', kind: 'test', start: '5001000001', end: '5001000010' });
  const rows = await Promise.all(Array.from({ length: 20 }, (_, i) => allocate(100 + i)));
  const numbers = rows.filter(Boolean).map((r) => r.number);
  assert.equal(numbers.length, 10);
  assert.equal(new Set(numbers).size, 10);
  assert.equal(rows.filter((r) => r === null).length, 10);
});

test('rejects overlapping ranges', async () => {
  await addRange(pool, { label: 'a', kind: 'test', start: '5001000001', end: '5001000010' });
  await assert.rejects(addRange(pool, { label: 'b', kind: 'production', start: '5001000010', end: '5001000020' }), /Overlaps/);
});

test('rangeStatus reports remaining numbers and the next one', async () => {
  await addRange(pool, { label: 'a', kind: 'test', start: '5001000001', end: '5001000010' });
  await allocate(1);
  const status = await rangeStatus(pool, 'test');
  assert.equal(status.remaining, 9);
  assert.equal(status.total, 10);
  assert.equal(status.ranges[0].next, '5001000002');
});
