import { withTransaction } from './db.js';
import { allocateNumber, rangeStatus } from './ranges.js';
import { buildBookingPayload } from './tpc/payload.js';

const MAX_BURNS_PER_BOOKING = 3;

export function parseTags(tags) {
  return String(tags ?? '').split(',').map((t) => t.trim()).filter(Boolean);
}

export function orderRef(order) {
  return {
    id: Number(order.id),
    gid: order.admin_graphql_api_id || `gid://shopify/Order/${order.id}`,
    name: order.name || `#${order.order_number ?? order.id}`,
  };
}

export function isCashOnDelivery(order) {
  return (order.payment_gateway_names ?? []).some((g) => /cash on delivery|\bcod\b/i.test(g))
    && order.financial_status === 'pending';
}

function skipReason(order) {
  if (order.cancelled_at) return 'order is cancelled';
  if (order.fulfillment_status === 'fulfilled') return 'order is already fulfilled';
  if (!(order.line_items ?? []).some((li) => li.requires_shipping !== false)) return 'nothing to ship';
  return null;
}

/**
 * Books orders with TPC and fulfils them when staff tag the order as handed over.
 * shopify: { addTags, removeTags, setMetafields, fulfil } (see shopify/client.js)
 * tpc:     { book(payload) -> { outcome, message, refNo } } (see tpc/client.js)
 */
export function createBookingService({ pool, shopify, tpc, config, log = console }) {
  const { tags } = config;
  const locks = new Map();
  let lastLowRangeWarning = 0;

  // Serialise work per order: Shopify often sends orders/paid and orders/updated together.
  function withOrderLock(orderId, fn) {
    const previous = locks.get(orderId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(fn);
    locks.set(orderId, next);
    next.finally(() => { if (locks.get(orderId) === next) locks.delete(orderId); }).catch(() => {});
    return next;
  }

  async function liveRow(orderId) {
    const { rows } = await pool.query(
      `SELECT * FROM consignments WHERE order_id = $1 AND status <> 'burned'`, [orderId]);
    return rows[0] ?? null;
  }

  async function updateRow(number, fields) {
    const keys = Object.keys(fields);
    const sets = keys.map((k, i) => `${k} = $${i + 2}`);
    const { rows } = await pool.query(
      `UPDATE consignments SET ${sets.join(', ')}, updated_at = now() WHERE number = $1 RETURNING *`,
      [number, ...keys.map((k) => fields[k])],
    );
    return rows[0];
  }

  // Shopify updates are best effort: the database is the source of truth, and a
  // Shopify hiccup must never cause a second booking.
  async function shopifySafely(label, fn) {
    try { await fn(); } catch (error) { log.error(`[shopify] ${label} failed: ${error.message}`); }
  }

  async function reportBooked(ref, row) {
    await shopifySafely(`mark ${ref.name} booked`, async () => {
      await shopify.setMetafields(ref.gid, {
        consignment_no: row.number,
        status: `Booked with TPC${row.tpc_ref_no ? ` (ref ${row.tpc_ref_no})` : ''}. Add tag "${tags.handover}" when the parcel is handed over.`,
      });
      await shopify.addTags(ref.gid, [tags.booked]);
      await shopify.removeTags(ref.gid, [tags.failed, tags.dryRun]);
    });
  }

  async function reportFailed(ref, message) {
    await shopifySafely(`mark ${ref.name} failed`, async () => {
      await shopify.setMetafields(ref.gid, {
        status: `TPC booking failed: ${message} Fix it, then add tag "${tags.retry}".`,
      });
      await shopify.addTags(ref.gid, [tags.failed]);
    });
  }

  async function warnIfRangeLow() {
    const { remaining, total } = await rangeStatus(pool, config.tpc.rangeKind);
    if (total && remaining <= Math.ceil(total * config.lowRangeWarnRatio)
        && Date.now() - lastLowRangeWarning > 3_600_000) {
      lastLowRangeWarning = Date.now();
      log.warn(`[range] Only ${remaining} of ${total} ${config.tpc.rangeKind} consignment numbers left. Ask TPC for a new range.`);
    }
  }

  async function allocate(ref) {
    try {
      const row = await withTransaction(pool, (client) => allocateNumber(client, config.tpc.rangeKind, ref));
      await warnIfRangeLow();
      return row;
    } catch (error) {
      // Another delivery of the same webhook won the race for this order.
      if (error.code === '23505') return liveRow(ref.id);
      throw error;
    }
  }

  /**
   * Send one booking to TPC and record the result. A "duplicate" reply after an earlier
   * attempt whose result we never saw means that attempt actually got through.
   */
  async function send(row, payload) {
    // attempts > 0 with no outcome: the app stopped while a request was in flight.
    const hadUnknown = row.last_outcome === 'unknown' || (row.attempts > 0 && !row.last_outcome);
    const body = { ...payload, consignmentno: row.number };
    row = await updateRow(row.number, { attempts: row.attempts + 1, payload: body });

    const result = await tpc.book(body);
    log.info(`[tpc] ${row.order_name} ${row.number} attempt ${row.attempts}: ${result.outcome} - ${result.message}`);

    if (result.outcome === 'booked' || (result.outcome === 'duplicate' && hadUnknown)) {
      row = await updateRow(row.number, {
        status: 'booked', last_outcome: 'booked', last_error: null,
        tpc_ref_no: result.refNo || null, booked_at: new Date(),
      });
      return { outcome: 'booked', row };
    }
    if (result.outcome === 'duplicate') {
      row = await updateRow(row.number, { status: 'burned', last_outcome: 'duplicate', last_error: result.message });
      return { outcome: 'duplicate', row };
    }
    if (result.outcome === 'rejected') {
      row = await updateRow(row.number, { status: 'failed', last_outcome: 'rejected', last_error: result.message });
      return { outcome: 'rejected', row, message: result.message };
    }
    const giveUp = row.attempts >= config.maxSendAttempts;
    row = await updateRow(row.number, {
      status: giveUp ? 'failed' : 'reserved', last_outcome: 'unknown', last_error: result.message,
    });
    return { outcome: giveUp ? 'gave-up' : 'unknown', row, message: result.message };
  }

  async function finish(ref, sent) {
    if (sent.outcome === 'booked') {
      await reportBooked(ref, sent.row);
      return { status: 'booked', number: sent.row.number };
    }
    if (sent.outcome === 'rejected') {
      await reportFailed(ref, `${sent.message}.`);
      return { status: 'failed', number: sent.row.number, message: sent.message };
    }
    if (sent.outcome === 'gave-up') {
      await reportFailed(ref, `TPC did not respond after ${sent.row.attempts} attempts (${sent.message}). Retrying is safe: consignment ${sent.row.number} is reused.`);
      return { status: 'failed', number: sent.row.number, message: sent.message };
    }
    await shopifySafely(`note pending ${ref.name}`, () => shopify.setMetafields(ref.gid, {
      consignment_no: sent.row.number,
      status: `Waiting for TPC (attempt ${sent.row.attempts}): ${sent.message}. Will retry automatically.`,
    }));
    return { status: 'pending', number: sent.row.number, message: sent.message };
  }

  async function bookOrder(order) {
    const ref = orderRef(order);
    return withOrderLock(ref.id, async () => {
      const reason = skipReason(order);
      if (reason) {
        log.info(`[booking] Skipping ${ref.name}: ${reason}`);
        return { status: 'skipped', reason };
      }

      let row = await liveRow(ref.id);
      if (row && ['booked', 'fulfilled'].includes(row.status)) return { status: 'already-booked', number: row.number };

      const { payload, errors } = buildBookingPayload(order, config.tpc);
      if (errors.length) {
        if (row) await updateRow(row.number, { status: 'failed', last_error: errors.join(' ') });
        log.warn(`[booking] ${ref.name} not bookable: ${errors.join(' | ')}`);
        await reportFailed(ref, errors.join(' '));
        return { status: 'invalid', errors };
      }

      if (config.tpc.mode === 'dry-run') {
        log.info(`[dry-run] ${ref.name} would be booked with: ${JSON.stringify(payload)}`);
        await shopifySafely(`note dry run ${ref.name}`, async () => {
          await shopify.setMetafields(ref.gid, {
            status: `Dry run OK: ${payload.weight} kg to ${payload.pincode}. ${payload.ship_adds1} / ${payload.ship_adds2} / ${payload.ship_adds3}`,
          });
          await shopify.addTags(ref.gid, [tags.dryRun]);
          await shopify.removeTags(ref.gid, [tags.failed]);
        });
        return { status: 'dry-run', payload };
      }

      for (let burns = 0; burns <= MAX_BURNS_PER_BOOKING; burns += 1) {
        row = row ?? await allocate(ref);
        if (!row) {
          const message = `No ${config.tpc.rangeKind} consignment numbers left. Add a new range from TPC.`;
          log.error(`[booking] ${ref.name}: ${message}`);
          await reportFailed(ref, message);
          return { status: 'failed', message };
        }
        if (['booked', 'fulfilled'].includes(row.status)) return { status: 'already-booked', number: row.number };

        const sent = await send(row, payload);
        if (sent.outcome !== 'duplicate') return finish(ref, sent);
        log.warn(`[booking] ${row.number} already exists at TPC; burned it and taking the next number.`);
        row = null;
      }
      const message = `TPC reported ${MAX_BURNS_PER_BOOKING + 1} consignment numbers in a row as already used. Check the range with TPC.`;
      await reportFailed(ref, message);
      return { status: 'failed', message };
    });
  }

  async function handover(order) {
    const ref = orderRef(order);
    return withOrderLock(ref.id, async () => {
      const row = await liveRow(ref.id);
      await shopifySafely(`remove handover tag ${ref.name}`, () => shopify.removeTags(ref.gid, [tags.handover]));

      if (row?.status === 'fulfilled') return { status: 'already-fulfilled', number: row.number };
      if (row?.status !== 'booked') {
        const message = `Tagged "${tags.handover}" but the order is not booked with TPC${row ? ` (status: ${row.status})` : ''}.`;
        log.warn(`[handover] ${ref.name}: ${message}`);
        await shopifySafely(`note handover problem ${ref.name}`, () => shopify.setMetafields(ref.gid, { status: message }));
        return { status: 'not-booked', message };
      }

      const url = config.fulfilment.trackingUrlTemplate.replaceAll('{number}', encodeURIComponent(row.number));
      try {
        await shopify.fulfil(ref.gid, {
          number: row.number,
          company: config.fulfilment.trackingCompany,
          url: url || undefined,
          notifyCustomer: config.fulfilment.notifyCustomer,
        });
      } catch (error) {
        log.error(`[handover] ${ref.name}: ${error.message}`);
        await shopifySafely(`note fulfil failure ${ref.name}`, () => shopify.setMetafields(ref.gid, {
          status: `Fulfilment failed: ${error.message} Add tag "${tags.handover}" again to retry.`,
        }));
        return { status: 'fulfil-failed', message: error.message };
      }

      await updateRow(row.number, { status: 'fulfilled', fulfilled_at: new Date() });
      await shopifySafely(`mark ${ref.name} fulfilled`, async () => {
        await shopify.setMetafields(ref.gid, { status: `Handed over to TPC and fulfilled. Tracking ${row.number}.` });
        await shopify.addTags(ref.gid, [tags.fulfilled]);
      });
      return { status: 'fulfilled', number: row.number };
    });
  }

  async function retry(order) {
    const ref = orderRef(order);
    await shopifySafely(`remove retry tag ${ref.name}`, () => shopify.removeTags(ref.gid, [tags.retry]));
    return bookOrder(order);
  }

  async function handleWebhook(topic, order) {
    switch (topic) {
      case 'orders/paid':
        return bookOrder(order);
      case 'orders/create':
        if (config.bookCodOrders && isCashOnDelivery(order)) return bookOrder(order);
        return { status: 'ignored' };
      case 'orders/updated': {
        const orderTags = parseTags(order.tags);
        if (orderTags.includes(tags.retry)) return retry(order);
        if (orderTags.includes(tags.handover)) return handover(order);
        return { status: 'ignored' };
      }
      default:
        return { status: 'ignored' };
    }
  }

  /** Re-send bookings whose outcome is still unknown (timeouts, TPC down, app restarted mid-send). */
  async function resendPending({ olderThanMs = 120_000 } = {}) {
    const { rows } = await pool.query(
      `SELECT * FROM consignments
        WHERE status = 'reserved' AND updated_at < now() - make_interval(secs => $1)
        ORDER BY updated_at`,
      [olderThanMs / 1000],
    );
    const results = [];
    for (const stale of rows) {
      const ref = { id: stale.order_id, gid: stale.order_gid, name: stale.order_name };
      results.push(await withOrderLock(ref.id, async () => {
        const row = await liveRow(ref.id);
        if (row?.number !== stale.number || row.status !== 'reserved') return { status: 'skipped' };
        if (!row.payload) {
          // The app stopped between taking the number and sending it, so TPC never saw it.
          await updateRow(row.number, { status: 'failed', last_error: 'Interrupted before sending to TPC.' });
          await reportFailed(ref, 'Booking was interrupted before reaching TPC.');
          return { status: 'failed', number: row.number };
        }
        const sent = await send(row, row.payload);
        if (sent.outcome === 'duplicate') {
          await reportFailed(ref, `TPC says consignment ${row.number} already exists for another booking.`);
          return { status: 'failed', number: row.number };
        }
        return finish(ref, sent);
      }));
    }
    return results;
  }

  return { handleWebhook, bookOrder, handover, retry, resendPending };
}
