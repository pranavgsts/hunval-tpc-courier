import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildBookingPayload, normalisePhone, packAddress, validatePayload, wrap } from '../src/tpc/payload.js';
import { makeOrder, testConfig } from './helpers.js';

const tpc = testConfig().tpc;

test('builds a valid TPC payload from a normal order', () => {
  const order = makeOrder({ id: 1001, name: '#1001' });
  const { payload, errors } = buildBookingPayload(order, tpc, '5001000001');
  assert.deepEqual(errors, []);
  assert.deepEqual(payload, {
    consignmentno: '5001000001',
    pincode: '637211',
    ship_adds1: 'Priya Raman',
    ship_adds2: '12, Gandhi Street, Near Bus Stand',
    ship_adds3: 'Tiruchengode, Tamil Nadu - 637211',
    ship_city: 'Tiruchengode',
    to_mobileno: '9876543210',
    weight: '1.000',
    content_desc: 'Apparel',
    content_value: '1499',
    no_of_pieces: '1',
    cust_refno: '1001',
    system_name: 'Shopify',
  });
  assert.deepEqual(validatePayload(payload), []);
});

test('weight is kg with three decimals, including packaging', () => {
  const order = makeOrder({ total_weight: 350, line_items: [{ title: 'Scarf', grams: 350, quantity: 1, requires_shipping: true }] });
  assert.equal(buildBookingPayload(order, tpc).payload.weight, '0.450');
});

test('falls back to summing line items when total_weight is missing', () => {
  const order = makeOrder({ total_weight: undefined, line_items: [{ title: 'Kurta', grams: 400, quantity: 3, requires_shipping: true }] });
  assert.equal(buildBookingPayload(order, tpc).payload.weight, '1.300');
});

test('flags items with no weight instead of guessing', () => {
  const order = makeOrder({ line_items: [{ title: 'Saree', grams: 0, quantity: 1, requires_shipping: true }] });
  const { errors } = buildBookingPayload(order, tpc);
  assert.match(errors.join(' '), /no weight set in Shopify: Saree/);
});

test('ignores digital items that do not ship', () => {
  const order = makeOrder({
    line_items: [
      { title: 'Kurta', grams: 800, quantity: 1, requires_shipping: true },
      { title: 'Gift card', grams: 0, quantity: 1, requires_shipping: false },
    ],
  });
  assert.deepEqual(buildBookingPayload(order, tpc).errors, []);
});

test('requires a phone number', () => {
  const order = makeOrder();
  order.shipping_address.phone = null;
  assert.match(buildBookingPayload(order, tpc).errors.join(' '), /No phone number/);
});

test('uses the order phone when the address has none', () => {
  const order = makeOrder({ phone: '09876543210' });
  order.shipping_address.phone = '';
  assert.equal(buildBookingPayload(order, tpc).payload.to_mobileno, '9876543210');
});

test('rejects orders without a shipping address', () => {
  assert.deepEqual(buildBookingPayload(makeOrder({ shipping_address: null }), tpc).errors, ['Order has no shipping address.']);
});

test('short street address puts city/state/pin on line 3', () => {
  const lines = packAddress({ name: 'Arun Kumar', address1: '4 MG Road', city: 'Salem', province: 'Tamil Nadu', zip: '636001' });
  assert.deepEqual(lines, { ship_adds1: 'Arun Kumar', ship_adds2: '4 MG Road', ship_adds3: 'Salem, Tamil Nadu - 636001' });
});

test('long street address wraps across lines 2 and 3', () => {
  const lines = packAddress({
    name: 'Arun Kumar',
    address1: 'Door No 45/2, Second Floor, Sri Lakshmi Apartments',
    address2: 'Periyar Nagar Main Road',
    city: 'Erode', zip: '638001',
  });
  assert.deepEqual(lines, {
    ship_adds1: 'Arun Kumar',
    ship_adds2: 'Door No 45/2, Second Floor, Sri Lakshmi',
    ship_adds3: 'Apartments, Periyar Nagar Main Road',
  });
});

test('a very short line 3 gets the locality appended', () => {
  const lines = packAddress({
    name: 'Arun Kumar',
    address1: 'Door No 45/2, Second Floor, Sri Lakshmi Apartment',
    address2: 'Nr',
    city: 'Erode', zip: '638001',
  });
  assert.equal(lines.ship_adds3, 'Nr, Erode - 638001');
});

test('city, state and PIN repeated in the address lines are dropped', () => {
  const lines = packAddress({
    name: 'Arun Kumar',
    address1: '4 MG Road, Erode',
    address2: 'Tamil Nadu, 638001, India',
    city: 'Erode', province: 'Tamil Nadu', zip: '638001',
  });
  assert.deepEqual(lines, { ship_adds1: 'Arun Kumar', ship_adds2: '4 MG Road', ship_adds3: 'Erode, Tamil Nadu - 638001' });
});

test('street over 100 characters flows into line 1 after the name', () => {
  const addr = {
    name: 'Arun Kumar',
    address1: 'Door No 45/2, Second Floor, Sri Lakshmi Residency, Block C',
    address2: 'Periyar Nagar Main Rd, Opp Govt Higher Secondary School, Bhd Temple',
    city: 'Erode', zip: '638001',
  };
  const lines = packAddress(addr);
  assert.equal(lines.error, undefined);
  for (const l of Object.values(lines)) assert.ok(l.length >= 5 && l.length <= 50, l);
  assert.ok(lines.ship_adds1.startsWith('Arun Kumar, '));
  const noCommas = (s) => s.replaceAll(',', '');
  assert.equal(noCommas(Object.values(lines).join(' ')), noCommas(`Arun Kumar, ${addr.address1}, ${addr.address2}`));
  assert.ok(Object.values(lines).every((l) => !l.endsWith(',')));
});

test('common words are abbreviated only when needed to fit', () => {
  const lines = packAddress({
    name: 'Arun Kumar',
    address1: 'Door Number 45/2, Second Floor, Sri Lakshmi Apartments, Block C',
    address2: 'Periyar Nagar Main Road, Opposite Government Higher Secondary School, Behind Temple',
    city: 'Erode', zip: '638001',
  });
  assert.equal(lines.error, undefined);
  const all = Object.values(lines).join(' ');
  assert.match(all, /Door No 45\/2, Second Flr, Sri Lakshmi Apts/);
  assert.match(all, /Opp Government/);
  for (const l of Object.values(lines)) assert.ok(l.length >= 5 && l.length <= 50, l);

  // A short address keeps its words as typed.
  assert.equal(packAddress({ name: 'Arun Kumar', address1: '4 Gandhi Road', city: 'Salem', zip: '636001' }).ship_adds2, '4 Gandhi Road');
});

test('an address too long even after shortening is reported, not cut off', () => {
  const lines = packAddress({
    name: 'Arun Kumar',
    address1: 'Door No 45/2, Second Floor, Sri Lakshmi Narasimha Swamy Residency, Block C, Wing 4',
    address2: 'Periyar Nagar Main Rd, Opp Govt Higher Secondary School, Bhd Sri Kamakshi Amman Temple, Landmark Big Banyan Tree',
    city: 'Erode', zip: '638001',
  });
  assert.match(lines.error, /too long for TPC/);
});

test('very short names are padded with the phone so line 1 reaches 5 characters', () => {
  const lines = packAddress({ name: 'Raj', address1: '4 MG Road', city: 'Salem', zip: '636001' }, '9876543210');
  assert.equal(lines.ship_adds1, 'Raj - 9876543210');
});

test('company is included on line 1', () => {
  const lines = packAddress({ name: 'Priya Raman', company: 'Raman Textiles', address1: '4 MG Road', city: 'Salem', zip: '636001' });
  assert.equal(lines.ship_adds1, 'Priya Raman, Raman Textiles');
});

test('wrap hard-splits words longer than a line', () => {
  assert.deepEqual(wrap('abc ' + 'x'.repeat(12), 5), ['abc', 'xxxxx', 'xxxxx', 'xx']);
});

test('normalisePhone strips country code and leading zero', () => {
  assert.equal(normalisePhone('+91 98765-43210'), '9876543210');
  assert.equal(normalisePhone('098765 43210'), '9876543210');
  assert.equal(normalisePhone(null), '');
});

test('long product titles and order names are trimmed to TPC limits', () => {
  const order = makeOrder({ name: '#HUNVAL-ORDER-000000123456' });
  const { payload, errors } = buildBookingPayload(order, { ...tpc, contentDesc: '' });
  assert.deepEqual(errors, []);
  assert.equal(payload.content_desc, 'Cotton Kurta');
  assert.equal(payload.cust_refno.length, 20);
});

test('validatePayload enforces TPC field rules', () => {
  const errors = validatePayload({ consignmentno: '123', pincode: '63A211' });
  assert.ok(errors.some((e) => e.startsWith('consignmentno must be 5-15')));
  assert.ok(errors.some((e) => e.startsWith('pincode must contain digits only')));
});
