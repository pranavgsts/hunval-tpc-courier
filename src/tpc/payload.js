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
// Common address words shortened only when the address doesn't fit otherwise.
const ABBREVIATIONS = [
  [/\bstreet\b/gi, 'St'], [/\broad\b/gi, 'Rd'], [/\bnear\b/gi, 'Nr'], [/\bopposite\b/gi, 'Opp'],
  [/\bapartments\b/gi, 'Apts'], [/\bapartment\b/gi, 'Apt'], [/\bbuilding\b/gi, 'Bldg'],
  [/\bfloor\b/gi, 'Flr'], [/\bbehind\b/gi, 'Bhd'], [/\bcolony\b/gi, 'Col'], [/\bextension\b/gi, 'Extn'],
  [/\bpost office\b/gi, 'PO'], [/\bnumber\b/gi, 'No'],
];
const abbreviate = (text) => ABBREVIATIONS.reduce((t, [re, short]) => t.replace(re, short), text);

const comparable = (s) => clean(s).toLowerCase().replace(/[\s.\-]+/g, ' ').trim();

/**
 * Street part of the address. Customers often repeat city, state and PIN in the address
 * lines; those parts are dropped because TPC gets them separately and space is tight.
 */
function streetText(addr) {
  const city = clean(addr.city);
  const province = clean(addr.province);
  const zip = clean(addr.zip);
  const drop = new Set([city, province, zip, 'india', `${city} ${zip}`, `${province} ${zip}`, `${province} india`]
    .map(comparable).filter(Boolean));
  return [addr.address1, addr.address2]
    .flatMap((line) => clean(line).split(','))
    .map(clean)
    .filter((part) => part && !drop.has(comparable(part)))
    .join(', ');
}

/** Line 3 is too short for TPC's 5-character minimum: append the locality. */
function fillShortLast(lines, locality) {
  const [l1, l2 = '', l3 = ''] = lines;
  if (!l3) return [l1, l2, truncate(locality, LINE_MAX)];
  if (l3.length < LINE_MIN) return [l1, l2, truncate(clean(`${l3}, ${locality}`), LINE_MAX)];
  return [l1, l2, l3];
}

/**
 * TPC wants three address lines of 5-50 characters each and has no separate name field.
 * Tries, in order, until one fits:
 *   1. name on line 1, street on lines 2-3 (city/state/PIN on line 3 if the street fits on one line)
 *   2. the same with common words abbreviated (Street -> St, Near -> Nr, ...)
 *   3. name and street flowing together across all three lines
 *   4. the same with abbreviations
 */
export function packAddress(addr, phone) {
  let name = truncate(clean([clean(addr.name) || clean([addr.first_name, addr.last_name].join(' ')), clean(addr.company)]
    .filter(Boolean).join(', ')), LINE_MAX);
  if (name.length < LINE_MIN && phone) name = truncate(clean(`${name} - ${phone}`), LINE_MAX);

  const street = streetText(addr);
  const locality = clean([clean(addr.city), clean(addr.province)].filter(Boolean).join(', ')
    + (clean(addr.zip) ? ` - ${clean(addr.zip)}` : ''));

  const nameOnOwnLine = (text) => {
    const lines = wrap(text, LINE_MAX);
    return lines.length <= 2 ? fillShortLast([name, ...lines], locality) : null;
  };
  const flowing = (text) => {
    const lines = wrap(clean(`${name}, ${text}`), LINE_MAX);
    return lines.length <= 3 ? fillShortLast(lines, locality) : null;
  };

  const lines = nameOnOwnLine(street) ?? nameOnOwnLine(abbreviate(street))
    ?? flowing(street) ?? flowing(abbreviate(street));
  if (!lines) {
    const length = `${name}, ${abbreviate(street)}`.length;
    return {
      error: `Address is too long for TPC: name and street are ${length} characters even after shortening, `
        + `and TPC allows 3 lines of ${LINE_MAX}. Shorten the shipping address (city, state and PIN are sent separately).`,
    };
  }
  // A wrap can leave a line ending in "," - drop it so labels read cleanly.
  const [ship_adds1, ship_adds2, ship_adds3] = lines.map((l) => l.replace(/[\s,]+$/, ''));
  return { ship_adds1, ship_adds2, ship_adds3 };
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
