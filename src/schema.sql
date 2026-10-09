-- Runs on every start; every statement is safe to repeat. MySQL 8 / MariaDB 10.5+.

-- Consignment number ranges issued by TPC. kind = 'test' for TPC's test numbers,
-- 'production' for the real range. Numbers are prefix + zero-padded next_num.
CREATE TABLE IF NOT EXISTS consignment_ranges (
  id          INT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  label       VARCHAR(255) NOT NULL,
  kind        VARCHAR(20) NOT NULL,
  prefix      VARCHAR(10) NOT NULL DEFAULT '',
  width       INT NOT NULL,
  start_num   BIGINT NOT NULL,
  end_num     BIGINT NOT NULL,
  next_num    BIGINT NOT NULL,
  active      TINYINT(1) NOT NULL DEFAULT 1,
  created_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  CONSTRAINT ranges_kind_chk CHECK (kind IN ('test', 'production')),
  CONSTRAINT ranges_order_chk CHECK (end_num >= start_num),
  CONSTRAINT ranges_next_chk CHECK (next_num BETWEEN start_num AND end_num + 1),
  KEY ranges_pick_idx (kind, active, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- One row per consignment number handed out.
--   reserved  : assigned to an order, booking not confirmed yet (or outcome unknown)
--   booked    : TPC confirmed the booking
--   failed    : TPC rejected it; the number stays with the order and is reused on retry
--   burned    : TPC says the number already exists elsewhere; never reused
--   fulfilled : parcel handed over, Shopify fulfilment created
-- live_order_id is NULL for burned rows, so its unique key allows one live number per order.
CREATE TABLE IF NOT EXISTS consignments (
  number         VARCHAR(15) NOT NULL PRIMARY KEY,
  range_id       INT UNSIGNED NOT NULL,
  order_id       BIGINT NOT NULL,
  order_gid      VARCHAR(100) NOT NULL,
  order_name     VARCHAR(100) NOT NULL,
  status         VARCHAR(20) NOT NULL,
  attempts       INT NOT NULL DEFAULT 0,
  last_outcome   VARCHAR(20) NULL,
  last_error     TEXT NULL,
  tpc_ref_no     VARCHAR(50) NULL,
  payload        JSON NULL,
  created_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at     DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  booked_at      DATETIME(3) NULL,
  fulfilled_at   DATETIME(3) NULL,
  live_order_id  BIGINT AS (IF(status <> 'burned', order_id, NULL)) STORED,
  CONSTRAINT consignments_status_chk CHECK (status IN ('reserved', 'booked', 'failed', 'burned', 'fulfilled')),
  UNIQUE KEY consignments_one_live_per_order (live_order_id),
  KEY consignments_order_idx (order_id),
  KEY consignments_status_idx (status, updated_at),
  CONSTRAINT consignments_range_fk FOREIGN KEY (range_id) REFERENCES consignment_ranges (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- Shopify can deliver the same webhook more than once.
CREATE TABLE IF NOT EXISTS webhook_events (
  webhook_id   VARCHAR(100) NOT NULL PRIMARY KEY,
  topic        VARCHAR(50) NOT NULL,
  received_at  DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
