import express from 'express';
import multer from 'multer';
import { validatePayload } from './payload.js';

/**
 * Stand-in for TPC's booking API, copying the documented behaviour: X-Api-Key/X-Api-Id
 * headers, multipart form fields, the field validation rules, duplicate consignment
 * numbers and the documented response bodies. Bookings are kept in memory.
 */
export function createMockTpcApp({ apiKey = 'test-key', apiId = '1' } = {}) {
  const app = express();
  const bookings = new Map();
  let refNo = 2000;
  const queuedFailures = [];

  app.post('/apps/api/booking', multer().none(), express.urlencoded({ extended: false }), (req, res) => {
    const failure = queuedFailures.shift();
    if (failure) return res.status(failure.status).json(failure.body ?? { error: 'Simulated failure' });

    const key = req.get('X-Api-Key');
    const id = req.get('X-Api-Id');
    if (!key || !id) return res.status(406).json({ msg: 'Authentication Key Missing' });
    if (key !== apiKey || String(id) !== String(apiId)) {
      return res.status(401).json({ REF_NO: '1001', REF_MESSAGE: 'Invalid API KEY. Please Contact Admin', ERROR_STATUS: 'FAILED' });
    }

    const errors = validatePayload(req.body ?? {});
    if (errors.length) return res.status(406).json({ errors: errors[0] });

    if (bookings.has(req.body.consignmentno)) {
      return res.status(406).json({
        REF_NO: '1006',
        REF_MESSAGE: 'This Consignment No. is Already Exist. Enter Valid Consignment No.',
        ERROR_STATUS: 'FAILED',
      });
    }

    refNo += 1;
    bookings.set(req.body.consignmentno, { ...req.body, REF_NO: String(refNo) });
    return res.json({ REF_NO: String(refNo), REF_MESSAGE: 'Successfully Saved.', ERROR_STATUS: 'SUCCESS' });
  });

  app.get('/bookings', (_req, res) => res.json([...bookings.values()]));

  return {
    app,
    bookings,
    /** Make the next request fail, e.g. failNext(502) to simulate TPC being down. */
    failNext(status, body) { queuedFailures.push({ status, body }); },
  };
}
