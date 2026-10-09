import { isDuplicateKey, withTransaction } from './db.js';

// TPC accepts 5-15 character consignment numbers.
const MIN_LENGTH = 5;
const MAX_LENGTH = 15;

export function formatConsignment(range, n) {
  // Check digit: TPC has not said whether their numbers carry one. If they do,
  // compute and append it here; allocation and storage already go through this function.
  return `${range.prefix}${String(n).padStart(range.width, '0')}`;
}

/**
 * Parse a range TPC gave us, e.g. start "5001000001" end "5001000010", or with a
 * letter prefix "TCG000001" .. "TCG000500". Both ends must share the prefix and width.
 */
export function parseRange(start, end) {
  const re = /^([A-Za-z]*)(\d+)$/;
  const a = re.exec(String(start).trim());
  const b = re.exec(String(end).trim());
  if (!a || !b) throw new Error('Start and end must be an optional letter prefix followed by digits.');
  if (a[1] !== b[1]) throw new Error(`Start and end have different prefixes (${a[1]} vs ${b[1]}).`);
  if (a[2].length !== b[2].length) throw new Error('Start and end must have the same number of digits.');

  const range = {
    prefix: a[1],
    width: a[2].length,
    start_num: Number(a[2]),
    end_num: Number(b[2]),
  };
  if (!Number.isSafeInteger(range.end_num)) throw new Error('Number too large.');
  if (range.end_num < range.start_num) throw new Error('End is before start.');

  const length = formatConsignment(range, range.start_num).length;
  if (length < MIN_LENGTH || length > MAX_LENGTH) {
    throw new Error(`Consignment numbers must be ${MIN_LENGTH}-${MAX_LENGTH} characters; these are ${length}.`);
  }
  return range;
}

export async function addRange(db, { label, kind, start, end }) {
  const range = parseRange(start, end);
  return withTransaction(db, async (conn) => {
    // Serialise range inserts so the overlap check can't race.
    await conn.query("SELECT GET_LOCK('tpc_add_range', 10)");
    try {
      const overlap = await conn.query(
        `SELECT id, label FROM consignment_ranges
          WHERE prefix = ? AND width = ? AND start_num <= ? AND end_num >= ?`,
        [range.prefix, range.width, range.end_num, range.start_num],
      );
      if (overlap.rows.length > 0) {
        throw new Error(`Overlaps existing range #${overlap.rows[0].id} (${overlap.rows[0].label}).`);
      }
      const { insertId } = await conn.query(
        `INSERT INTO consignment_ranges (label, kind, prefix, width, start_num, end_num, next_num)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [label, kind, range.prefix, range.width, range.start_num, range.end_num, range.start_num],
      );
      const { rows } = await conn.query('SELECT * FROM consignment_ranges WHERE id = ?', [insertId]);
      return rows[0];
    } finally {
      await conn.query("SELECT RELEASE_LOCK('tpc_add_range')");
    }
  });
}

export async function deactivateRange(db, id) {
  await db.query('UPDATE consignment_ranges SET active = 0 WHERE id = ?', [id]);
}

/**
 * Take the next unused number and record it against the order, in one transaction,
 * so two orders arriving together can never get the same number.
 * Returns the new consignments row, or null when every active range of this kind is used up.
 */
export async function allocateNumber(conn, kind, order) {
  for (;;) {
    const { rows: ranges } = await conn.query(
      `SELECT * FROM consignment_ranges
        WHERE active = 1 AND kind = ? AND next_num <= end_num
        ORDER BY id LIMIT 1 FOR UPDATE`,
      [kind],
    );
    const range = ranges[0];
    if (!range) return null;

    const n = range.next_num;
    await conn.query('UPDATE consignment_ranges SET next_num = next_num + 1 WHERE id = ?', [range.id]);

    const number = formatConsignment(range, n);
    try {
      await conn.query(
        `INSERT INTO consignments (number, range_id, order_id, order_gid, order_name, status)
         VALUES (?, ?, ?, ?, ?, 'reserved')`,
        [number, range.id, order.id, order.gid, order.name],
      );
    } catch (error) {
      // Number already recorded (e.g. entered by hand earlier) - move on to the next one.
      if (isDuplicateKey(error, 'PRIMARY')) continue;
      throw error;
    }
    const { rows } = await conn.query('SELECT * FROM consignments WHERE number = ?', [number]);
    return rows[0];
  }
}

export async function rangeStatus(db, kind) {
  const { rows } = await db.query(
    `SELECT id, label, kind, prefix, width, start_num, end_num, next_num, active,
            GREATEST(end_num - next_num + 1, 0) AS remaining,
            end_num - start_num + 1 AS total
       FROM consignment_ranges
      WHERE (? IS NULL OR kind = ?)
      ORDER BY id`,
    [kind ?? null, kind ?? null],
  );
  const active = rows.filter((r) => r.active);
  return {
    ranges: rows.map((r) => ({
      ...r,
      active: Boolean(r.active),
      remaining: Number(r.remaining),
      total: Number(r.total),
      next: r.next_num <= r.end_num ? formatConsignment(r, r.next_num) : null,
    })),
    remaining: active.reduce((sum, r) => sum + Number(r.remaining), 0),
    total: active.reduce((sum, r) => sum + Number(r.total), 0),
  };
}
