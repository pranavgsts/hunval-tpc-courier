import { readFile } from 'node:fs/promises';
import mysql from 'mysql2/promise';

/**
 * Thin wrapper over mysql2 so the rest of the app just calls
 * db.query(sql, params) -> { rows, affectedRows, insertId }.
 * Works with MySQL 8 and MariaDB 10.5+.
 */
function wrap(target) {
  return {
    async query(sql, params = []) {
      const [result] = await target.query(sql, params);
      return Array.isArray(result)
        ? { rows: result, affectedRows: 0, insertId: 0 }
        : { rows: [], affectedRows: result.affectedRows, insertId: result.insertId };
    },
  };
}

/** `database` is a mysql:// URL or { host, port, user, password, database }. */
export function createPool(database) {
  let connection = database;
  if (typeof database === 'string') {
    if (!URL.canParse(database)) {
      // Don't echo the URL: it contains the password.
      throw new Error('DATABASE_URL is not a valid URL. Special characters in the password (# @ : / ? %) must be '
        + 'URL-encoded (e.g. # as %23), or set DB_HOST, DB_USER, DB_PASSWORD and DB_NAME instead.');
    }
    connection = { uri: database };
  }
  const pool = mysql.createPool({
    ...connection,
    connectionLimit: 10,
    // Store and read every timestamp as UTC.
    timezone: 'Z',
    supportBigNumbers: true,
    decimalNumbers: true,
  });
  pool.pool.on('connection', (conn) => conn.query("SET time_zone = '+00:00'"));

  return {
    ...wrap(pool),
    raw: pool,
    end: () => pool.end(),
  };
}

export async function migrate(db) {
  const sql = await readFile(new URL('./schema.sql', import.meta.url), 'utf8');
  const statements = sql
    .split(/;\s*$/m)
    .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
    .filter(Boolean);
  for (const statement of statements) await db.query(statement);
}

export async function withTransaction(db, fn) {
  const conn = await db.raw.getConnection();
  try {
    // READ COMMITTED avoids InnoDB gap locks, so concurrent bookings only wait on the range row.
    await conn.query('SET TRANSACTION ISOLATION LEVEL READ COMMITTED');
    await conn.beginTransaction();
    const result = await fn(wrap(conn));
    await conn.commit();
    return result;
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
  }
}

export const isDuplicateKey = (error, key) =>
  error?.code === 'ER_DUP_ENTRY' && (!key || String(error.message).includes(key));
