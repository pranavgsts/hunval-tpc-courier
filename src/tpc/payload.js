// Field rules from TPC's API doc (http://tcg.tpctn.in/api_document/).
// [min length, max length, digits only]
export const FIELD_RULES = {
  consignmentno: [5, 15, false],
  pincode: [4, 8, true],
  ship_adds1: [5, 50, false],
  ship_adds2: [5, 50, false],
  ship_adds3: [5, 50, false],
  ship_city: [2, 50, false],
  to_mobileno: [1, 20, true],
  weight: [5, 20, false],
  content_desc: [2, 20, false],
  content_value: [2, 20, true],
  no_of_pieces: [1, 20, true],
  cust_refno: [1, 20, false],
  system_name: [1, 30, false],
};
export const OPTIONAL_FIELDS = { to_customer_gst_id: [1, 20, false] };

const LINE_MAX = 50;
const LINE_MIN = 5;

export function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function truncate(value, max) {
  return value.length <= max ? value : value.slice(0, max).trimEnd();
}

/** Word-wrap text into lines of at most `max` characters, hard-splitting overlong words. */
export function wrap(text, max) {
  const lines = [];
  let line = '';
  for (let word of clean(text).split(' ').filter(Boolean)) {
    while (word.length > max) {
      if (line) { lines.push(line); line = ''; }
      lines.push(word.slice(0, max));
      word = word.slice(max);
    }
    if (!line) line = word;
    else if (line.length + 1 + word.length <= max) line += ` ${word}`;
    else { lines.push(line); line = word; }
  }
  if (line) lines.push(line);
  return lines;
}

/** Indian mobile numbers: drop +91 / leading 0 so TPC gets the 10-digit number. */
export function normalisePhone(raw) {
  let digits = String(raw ?? '').replace(/\D/g, '');
  if (digits.length === 12 && digits.startsWith('91')) digits = digits.slice(2);
  else if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  return digits;
}

/**
 * TPC wants three address lines of 5-50 characters each and has no separate name field.
 *   line 1: recipient name (and company)
 *   lines 2-3: street address, wrapped; if it fits on one line, line 3 is "City, State - PIN"
 */
export function packAddress(addr, phone) {
  const name = clean([clean(addr.name) || clean([addr.first_name, addr.last_name].join(' ')), clean(addr.company)]
    .filter(Boolean).join(', '));
  let line1 = truncate(name, LINE_MAX);
  if (line1.length < LINE_MIN && phone) line1 = truncate(clean(`${line1} - ${phone}`), LINE_MAX);

  const street = [clean(addr.address1), clean(addr.address2)].filter(Boolean);
  const locality = clean([clean(addr.city), clean(addr.province)].filter(Boolean).join(', ')
    + (clean(addr.zip) ? ` - ${clean(addr.zip)}` : ''));

  const lines = wrap(street.join(', '), LINE_MAX);
  if (lines.length > 2) {
    return { error: `Address lines are too long for TPC (max ${LINE_MAX * 2} characters for the street address, excluding name and city). Shorten the shipping address.` };
  }
  let [line2 = '', line3 = ''] = lines;
  if (!line3) {
    line3 = truncate(locality, LINE_MAX);
  } else if (line3.length < LINE_MIN) {
    line3 = truncate(clean(`${line3}, ${locality}`), LINE_MAX);
  }
  return { ship_adds1: line1, ship_adds2: line2, ship_adds3: line3 };
}

export function validatePayload(payload) {
  const errors = [];
  const check = (field, [min, max, digitsOnly], required) => {
    const value = payload[field] ?? '';
    if (value === '' && !required) return;
    if (value.length < min || value.length > max) {
      errors.push(`${field} must be ${min}-${max} characters (got ${value.length}: "${value}")`);
    } else if (digitsOnly && !/^\d+$/.test(value)) {
      errors.push(`${field} must contain digits only (got "${value}")`);
    }
  };
  for (const [field, rule] of Object.entries(FIELD_RULES)) check(field, rule, true);
  for (const [field, rule] of Object.entries(OPTIONAL_FIELDS)) check(field, rule, false);
  return errors;
}

/**
 * Build TPC's booking form fields from a Shopify order (webhook / REST JSON shape).
 * Returns { payload, errors }. The consignment number is filled in separately so a
 * number is only spent once the order is known to be bookable.
 */
export function buildBookingPayload(order, tpcConfig, consignmentNo = '') {
  const errors = [];
  const addr = order.shipping_address;
  if (!addr) return { payload: null, errors: ['Order has no shipping address.'] };

  const phone = normalisePhone(addr.phone || order.phone || order.customer?.phone || order.billing_address?.phone);
  if (!phone) errors.push('No phone number on the shipping address, order or customer.');

  const address = packAddress(addr, phone);
  if (address.error) errors.push(address.error);

  const shippable = (order.line_items ?? []).filter((li) => li.requires_shipping !== false);
  const weightless = shippable.filter((li) => !Number(li.grams));
  if (weightless.length) {
    errors.push(`These items have no weight set in Shopify: ${weightless.map((li) => li.title).join(', ')}.`);
  }
  const productGrams = Number(order.total_weight) || shippable.reduce((g, li) => g + Number(li.grams || 0) * (li.quantity || 1), 0);
  const weightKg = (productGrams + tpcConfig.packagingGrams) / 1000;

  const value = Math.round(Number(order.current_subtotal_price ?? order.subtotal_price ?? order.total_price ?? 0));

  const payload = {
    consignmentno: consignmentNo,
    pincode: String(addr.zip ?? '').replace(/\D/g, ''),
    ship_adds1: address.ship_adds1 ?? '',
    ship_adds2: address.ship_adds2 ?? '',
    ship_adds3: address.ship_adds3 ?? '',
    ship_city: truncate(clean(addr.city), 50),
    to_mobileno: phone,
    // TPC wants kg; three decimals keeps it at the 5-character minimum ("0.500").
    weight: weightKg.toFixed(3),
    content_desc: truncate(clean(tpcConfig.contentDesc || shippable[0]?.title || 'Goods'), 20),
    content_value: String(value).padStart(2, '0'),
    no_of_pieces: String(tpcConfig.noOfPieces),
    cust_refno: truncate(clean(order.name).replace(/^#/, ''), 20),
    system_name: truncate(tpcConfig.systemName, 30),
  };

  // Validate everything except the consignment number, which is added later.
  const fieldErrors = validatePayload({ ...payload, consignmentno: payload.consignmentno || '00000' })
    // Address problems are already reported in plain words above.
    .filter((e) => !(address.error && e.startsWith('ship_adds')));
  return { payload, errors: [...errors, ...fieldErrors] };
}
