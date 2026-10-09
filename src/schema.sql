-- Consignment number ranges issued by TPC. kind = 'test' for TPC's test numbers,
-- 'production' for the real range. Numbers are prefix + zero-padded next_num.
CREATE TABLE IF NOT EXISTS consignment_ranges (
  id          SERIAL PRIMARY KEY,
  label       TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('test', 'production')),
  prefix      TEXT NOT NULL DEFAULT '',
  width       INTEGER NOT NULL,
  start_num   BIGINT NOT NULL,
  end_num     BIGINT NOT NULL,
  next_num    BIGINT NOT NULL,
  active      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (end_num >= start_num),
  CHECK (next_num BETWEEN start_num AND end_num + 1)
);

-- One row per consignment number handed out.
--   reserved  : assigned to an order, booking not confirmed yet (or outcome unknown)
--   booked    : TPC confirmed the booking
--   failed    : TPC rejected it; the number stays with the order and is reused on retry
--   burned    : TPC says the number already exists elsewhere; never reused
--   fulfilled : parcel handed over, Shopify fulfilment created
CREATE TABLE IF NOT EXISTS consignments (
  number        TEXT PRIMARY KEY,
  range_id      INTEGER NOT NULL REFERENCES consignment_ranges(id),
  order_id      BIGINT NOT NULL,
  order_gid     TEXT NOT NULL,
  order_name    TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('reserved', 'booked', 'failed', 'burned', 'fulfilled')),
  attempts      INTEGER NOT NULL DEFAULT 0,
  last_outcome  TEXT,
  last_error    TEXT,
  tpc_ref_no    TEXT,
  payload       JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  booked_at     TIMESTAMPTZ,
  fulfilled_at  TIMESTAMPTZ
);

-- An order holds at most one live (non-burned) consignment number.
CREATE UNIQUE INDEX IF NOT EXISTS consignments_one_live_per_order
  ON consignments (order_id) WHERE status <> 'burned';

CREATE INDEX IF NOT EXISTS consignments_status_idx ON consignments (status, updated_at);

-- Shopify can deliver the same webhook more than once.
CREATE TABLE IF NOT EXISTS webhook_events (
  webhook_id   TEXT PRIMARY KEY,
  topic        TEXT NOT NULL,
  received_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
