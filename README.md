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

### 2. Run it locally

Needs Node 20.12+ and MySQL 8 (or MariaDB 10.5+). On a Mac: `brew install mysql && brew services start mysql`.

```bash
npm install
cp .env.example .env        # then fill in the values
mysql -uroot -e "CREATE DATABASE tpc_courier"
npm run range:add -- test TCG200001 TCG200025 "TPC test numbers"
npm run mock:tpc            # terminal 1: fake TPC API on :4010
npm start                   # terminal 2: the app on :3000 (creates its tables on start)
```

**Shopify webhooks need a public HTTPS address,** so while running locally, open a tunnel to port 3000 in a third terminal:

```bash
cloudflared tunnel --url http://localhost:3000   # brew install cloudflared; prints an https://….trycloudflare.com address
npm run shopify:setup -- https://<that-address>
```

The tunnel address changes every time cloudflared restarts, so re-run `shopify:setup` with the new one. The script removes subscriptions to the old address.

### 3. Host on the Webuzo server

1. **Database.** In Webuzo → Databases, create a database and a user, give the user all privileges on it, and note the host (usually `localhost`).
2. **Domain and SSL.** Add a subdomain such as `tpc.yourdomain.com` and issue a Let's Encrypt certificate for it. Shopify only sends webhooks to HTTPS.
3. **Upload the code** to a folder outside `public_html`, e.g. with `git clone` over SSH, or upload a zip without `node_modules` and `.env`. Then in that folder run:
   ```bash
   npm ci --omit=dev
   ```
4. **Create the Node.js app** in Webuzo's Application Manager:
   - Node.js 20.12 or newer
   - start file `src/server.js` (or command `npm start`)
   - port, e.g. `3000`
   - the subdomain from step 2

   Webuzo then proxies the subdomain to that port. Enter the variables from `.env.example` in the app's environment settings, or put a `.env` file in the app folder (never inside `public_html`). `DATABASE_URL` is `mysql://dbuser:password@localhost:3306/dbname`, with special characters in the password URL-encoded.
5. **Start the app,** then check `https://tpc.yourdomain.com/health`.
6. **One-time setup on the server:**
   ```bash
   npm run shopify:setup -- https://tpc.yourdomain.com
   npm run range:add -- test TCG200001 TCG200025 "TPC test numbers"
   npm run range:add -- production TCG660001 TCG670000 "Hunter Readymades live range"
   ```

If your Webuzo version has no Node.js application manager, run it with pm2 instead (`npm i -g pm2 && pm2 start src/server.js --name tpc-courier && pm2 save && pm2 startup`), and add a reverse proxy from the subdomain to `http://127.0.0.1:3000`.

**The app must stay running all the time.** It answers Shopify webhooks, and every 5 minutes it re-sends bookings TPC didn't confirm. Make sure the app manager or pm2 restarts it after a crash or server reboot.

`shopify:setup` subscribes the `orders/paid`, `orders/create` and `orders/updated` webhooks to the given address, and creates the two pinned order metafields staff see on the order page. It's safe to run again.

### 4. Consignment ranges

```bash
npm run range:add -- test TCG200001 TCG200025 "TPC test numbers"
npm run range:add -- production TCG660001 TCG670000 "Hunter Readymades live range"
npm run range:status
```

Use the exact first and last numbers TPC gives you, including any letter prefix or leading zeros. `TPC_RANGE_KIND` picks which kind is used. The app logs a warning when 10% of the active range is left, and `/health` shows numbers remaining.

## Going live with TPC's test numbers

TPC has no sandbox: tests use the live API key, with 25 test consignment numbers (TCG200001–TCG200025).

1. **Develop against the mock.** Run `npm run mock:tpc` with `TPC_MODE=live` and `TPC_API_URL=http://localhost:4010/apps/api/booking`. The mock copies TPC's documented validation, duplicate check and responses.
2. **Dry run on the real store.** Set `TPC_MODE=dry-run`, place a few real orders, and check **TPC booking status** on each. It shows the weight, pincode and the three address lines that would be sent. No numbers are used.
3. **Real test bookings.** Set `TPC_MODE=live`, the real `TPC_API_URL`, keys, and `TPC_RANGE_KIND=test`. Suggested tests:
   - a normal order
   - an order with an empty address line 2
   - a long address
   - a multi-item order, to check the total weight
   - a handover → fulfil

   That leaves about 20 numbers spare. Ask TPC to cancel these test bookings.
4. **Go live.** Add the production range, then set `TPC_RANGE_KIND=production`.

## Development

```bash
npm test          # needs local MySQL; uses mysql://root@localhost:3306/tpc_courier_test (override with TEST_DATABASE_URL)
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
