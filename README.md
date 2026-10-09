# Hunval × The Professional Courier (TPC)

A small Shopify custom app that books every paid Hunval order with TPC (Thiruchengode) automatically, and fulfils the order in Shopify, with the tracking number, when staff hand the parcel over.

## How it works

```
Order paid ──► webhook ──► app takes the next consignment number from TPC's range
                           ──► books it with TPC's API
                           ──► order gets tag "tpc-booked" + consignment no. on the order page

Staff pack the parcel, write/stick the consignment no., hand it to TPC
  ──► add tag "tpc-handover" to the order (bulk-tag works from the Orders list)
  ──► app fulfils the order with the consignment no. as tracking ──► customer gets Shopify's shipping email
```

### What staff see and do

| Order tag | Meaning | Staff action |
|---|---|---|
| `tpc-booked` | Booked with TPC. Consignment no. is in the **TPC consignment no.** field on the order page. | Pack, label, hand over, then add `tpc-handover`. |
| `tpc-failed` | Could not book. The reason is in **TPC booking status**, e.g. missing phone, address too long, product with no weight. | Fix the order (edit address / product weight), then add `tpc-retry`. |
| `tpc-handover` | Added by staff. The app fulfils the order and removes this tag. | — |
| `tpc-fulfilled` | Fulfilled with TPC tracking. | — |
| `tpc-dry-run` | Only in dry-run mode: shows what *would* be booked. | — |

## Rules the app applies

- **Consignment numbers** come from ranges TPC allocates. Each number is taken in a database transaction, so two orders can never share one. Numbers are only spent once the order passes every TPC field check.
- **Retries never waste numbers.** If TPC rejects a booking, the order keeps its number for the retry. If TPC times out, the app re-sends every 5 minutes (up to 5 attempts). If TPC then says "already exists", the app knows the earlier attempt got through, and counts the order as booked.
- **A number TPC already has from elsewhere** is marked burned, and the next one is used.
- **Weight** = Shopify product weights + `PACKAGING_GRAMS`, sent in kg with 3 decimals (`0.450`). Orders containing a shippable product with no weight are flagged, not guessed.
- **Address**: TPC needs three lines of 5–50 characters and has no name field. Line 1 is the recipient name, and lines 2–3 are the street address. Short addresses get "City, State - PIN" on line 3. Addresses that don't fit are flagged for staff to shorten.
- **Phone** is normalised to 10 digits (drops `+91` / leading `0`).
- **Cancelled, already-fulfilled and digital-only orders** are skipped.
- **COD orders** are not booked unless `BOOK_COD_ORDERS=true`. TPC's API has no COD amount field, so confirm with TPC how they handle COD first.

## Setup

### 1. Shopify app (Dev Dashboard)

The client (store owner) creates an app at dev.shopify.com with their Shopify login, installs it on the store, and adds you as a collaborator. Access scopes:

- `read_orders`, `write_orders`: read orders, set tags and metafields
- `read_merchant_managed_fulfillment_orders`, `write_merchant_managed_fulfillment_orders`: fulfil orders

Copy the **Client ID** and **Client secret** from the app's Settings. The app gets its own access tokens with the client-credentials grant, so no token needs copying.

### 2. Host

Any Node 20.12+ host with Postgres and a public HTTPS URL, such as Render (web service + Postgres) or Fly.io. Set the variables from `.env.example` in the host's environment settings, not in a committed file.

```bash
npm install
npm start
```

### 3. One-time store setup

```bash
npm run shopify:setup -- https://your-app-url.example.com
```

This subscribes the `orders/paid`, `orders/create` and `orders/updated` webhooks, and creates the two pinned order metafields staff see on the order page.

### 4. Consignment ranges

```bash
npm run range:add -- test 5001000001 5001000010 "TPC test numbers"
npm run range:add -- production 5001000011 5001010000 "TPC range Oct 2026"
npm run range:status
```

Use the exact first and last numbers TPC gives you, including any letter prefix or leading zeros. `TPC_RANGE_KIND` picks which kind is used. The app logs a warning when 10% of the active range is left, and `/health` shows numbers remaining.

## Going live with only 10 test numbers

TPC has no sandbox: tests use the live API key, with 10 test consignment numbers.

1. **Develop against the mock.** Run `npm run mock:tpc` with `TPC_MODE=live` and `TPC_API_URL=http://localhost:4010/apps/api/booking`. The mock copies TPC's documented validation, duplicate check and responses.
2. **Dry run on the real store.** Set `TPC_MODE=dry-run`, place a few real orders, and check **TPC booking status** on each. It shows the weight, pincode and the three address lines that would be sent. No numbers are used.
3. **Real test bookings.** Set `TPC_MODE=live`, the real `TPC_API_URL`, keys, and `TPC_RANGE_KIND=test`. Suggested tests:
   - a normal order
   - an order with an empty address line 2
   - a long address
   - a multi-item order, to check the total weight
   - a handover → fulfil

   That keeps about 5 numbers spare. Ask TPC to cancel these test bookings.
4. **Go live.** Add the production range, then set `TPC_RANGE_KIND=production`.

## Development

```bash
npm test          # needs a local Postgres; uses postgres://localhost:5432/tpc_courier_test (override with TEST_DATABASE_URL)
npm run dev       # server with auto-restart
npm run mock:tpc  # fake TPC API on :4010
```

## Open items with TPC

- **Check digit:** does the range include one? If yes, add it in `formatConsignment` in `src/ranges.js`.
- **HTTPS:** their API is plain HTTP, so the API key travels unencrypted. Ask for an HTTPS endpoint.
- **`system_name`:** what value they expect (currently `Shopify`).
- **Tracking page URL:** set `TRACKING_URL_TEMPLATE`, e.g. `https://…?id={number}`, so customers get a clickable link.
- **COD:** whether they support it through this API.
- **Order status:** TPC's API is booking-only, so Shopify won't get delivery updates.
