import assert from 'node:assert/strict';
import { test } from 'node:test';
import { classify } from '../src/tpc/client.js';

// Replies as the live API sends them (array-wrapped) and as the doc shows them (bare object).
const success = { REF_NO: '2002', REF_MESSAGE: 'Successfully Saved.', ERROR_STATUS: 'SUCCESS' };
const duplicate = { REF_NO: '1006', REF_MESSAGE: 'This Consignment No. is Already Exist. Enter Valid Consignment No.', ERROR_STATUS: 'FAILED' };
const badKey = { REF_NO: '1001', REF_MESSAGE: 'Invalid API KEY. Please Contact Admin', ERROR_STATUS: 'FAILED' };

for (const [form, wrapFn] of [['array-wrapped (live)', (b) => [b]], ['bare object (doc)', (b) => b]]) {
  test(`${form}: success is booked with TPC's ref`, () => {
    assert.deepEqual(classify(200, wrapFn(success)), { outcome: 'booked', status: 200, refNo: '2002', message: 'Successfully Saved.' });
  });

  test(`${form}: existing consignment number is a duplicate`, () => {
    assert.equal(classify(406, wrapFn(duplicate)).outcome, 'duplicate');
  });

  test(`${form}: wrong key shows TPC's message`, () => {
    const result = classify(401, wrapFn(badKey));
    assert.equal(result.outcome, 'rejected');
    assert.match(result.message, /Invalid API KEY/);
  });
}

test('validation errors and missing-key replies are rejections with the reason', () => {
  assert.deepEqual(classify(406, { errors: 'The pincode field must be at least 4 characters in length.' }),
    { outcome: 'rejected', status: 406, message: 'The pincode field must be at least 4 characters in length.' });
  assert.match(classify(406, { msg: 'Authentication Key Missing' }).message, /Authentication Key Missing/);
});

test('server errors and empty arrays never count as booked', () => {
  assert.equal(classify(502, [success]).outcome, 'unknown');
  assert.equal(classify(200, []).outcome, 'rejected');
});
