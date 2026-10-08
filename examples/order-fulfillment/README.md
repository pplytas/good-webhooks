# Northstar Supply

A small shop admin and warehouse receiver built with the published `good-webhooks@0.1.0-alpha.3` package. Place an order, watch its delivery, take the warehouse offline, and replay an event without creating a second shipment.

This is an independent npm application. It has its own lockfile and does not use the repository's package source or pnpm workspace. You can copy this directory elsewhere and run it.

## Run locally

Requirements: Node.js 24 or later and Docker Compose.

```sh
cd examples/order-fulfillment
npm ci
docker compose up -d --wait
npm run setup
npm run dev
```

Open [Northstar Supply](http://127.0.0.1:4311). The supervisor starts three separate Node processes: the shop on `4311`, the warehouse receiver on `4411`, and the delivery worker. PostgreSQL binds only to `127.0.0.1:55441`.

`npm run setup` creates an ignored `.env` once, with a random encryption key, then applies the versioned migrations. Running it again verifies the migration checksums and preserves existing data. Keep `.env` while you retain the database. Replacing its key makes existing signing material unreadable.

The database uses a named Docker volume. `docker compose down` stops it without deleting orders or history. Starting it again and running `npm run dev` restores the same endpoint, orders, deliveries, and warehouse receipts. Do not remove the volume unless you intend to discard this example's data.

If the default ports are occupied, change `APP_PORT` and `RECEIVER_PORT` in `.env`, or change the Compose database port and `DATABASE_URL` together. Set ports before connecting the warehouse because endpoint URLs persist. For an existing PostgreSQL server, supply `DATABASE_URL` before the first setup. The example uses its own `northstar` schema; `APP_SCHEMA` can select another valid schema before setup.

## Try the flows

1. Connect the warehouse. The app creates one endpoint subscribed to `order.placed`. Repeating the connection reuses it. The app encrypts the returned signing secret in its own receiver configuration table.
2. Place an order. The server prices the product and commits the order together with `webhooks.publish(..., { transaction: client })`. The separate worker sends the request. The warehouse verifies its exact bytes, commits a receipt and shipment together, then returns `200`.
3. Open a delivery to see the actual attempt count, response code, recorded response body, and next scheduled attempt.
4. Set the warehouse to reject requests, then place another order. It returns `503`. The worker makes one initial attempt and up to three retries, with delays of 1, 3, and 6 seconds. Wait roughly 12 seconds for the delivery to fail. These short delays are explicit demo configuration in `src/runtime.ts`.
5. Restore the warehouse and replay the failed original delivery. The new delivery has a different delivery ID and retains the event ID. The warehouse creates one shipment.
6. Replay an already successful original delivery. The warehouse returns success, increments its duplicate counter, and keeps the existing shipment. A replay itself cannot be replayed. Select the original delivery again.
7. Use the rollback option when placing an order. The API deliberately rolls back after preparing publication. Neither the order nor its delivery appears. Retrying that request key without rollback can succeed.
8. Pause the endpoint and place an order. It still selects the subscribed warehouse, but stays pending without an HTTP attempt. Resume the endpoint and the worker delivers the retained event.
9. Stop and restart the processes with Ctrl+C and `npm run dev`. Existing data and keys remain. For an explicit queue test, run the app and receiver separately, place an order while no worker runs, then start the worker.

The dashboard shows the latest 50 orders, deliveries, and shipments. Its receiver counters cover all retained receipts. It polls actual persisted state through the public delivery APIs and app-owned tables. It does not simulate delivery status.

## Run processes separately

Run setup first, then use separate terminals:

```sh
npm run build
npm start
npm run receiver
npm run worker
```

The worker uses `worker.run()` with a 250 ms idle poll interval and a five-second grace period. It stops claiming work on SIGTERM or SIGINT, waits for active delivery work, and then closes its pool. The process has a 20-second final shutdown deadline. The development supervisor stops all children if one exits unexpectedly and forces remaining children to stop after 25 seconds.

## Verify

```sh
npm run typecheck
npm run build
npm test
```

Tests require PostgreSQL and use the Compose database by default. To use another test server:

```sh
TEST_DATABASE_URL='postgres://user:password@127.0.0.1:5432/test_database' npm test
```

Each run creates a random schema, applies the migrations, launches real HTTP app, receiver, and worker processes on free ports, and removes only that run's schema. Tests never truncate or reset existing application tables. The database role needs permission to create and drop its own schema.

Coverage includes input and origin checks, concurrent connection and order idempotency, server prices, atomic rollback, delivery with a separate worker, actual signed requests, invalid signatures, retry exhaustion, replay, deduplication after receiver restart, paused delivery, worker restart, and clean SIGTERM shutdown.

## How it fits together

```text
Shop HTTP request
    -> PostgreSQL transaction: order + webhook publication
    -> separate continuous worker
    -> signed HTTP request
    -> warehouse transaction: receipt + shipment
```

`src/application.ts` owns the business transaction and local administration API. `src/worker.ts` owns delivery execution. `src/receiver-app.ts` owns signature verification and durable receiver idempotency. They share an event schema and this example's database for convenience. Real external receivers would own their database, secret transfer, and deployment independently.

The `001-app.sql` migration creates business and receiver tables. `002-good-webhooks-alpha.2.sql` is the combined SQL emitted by the installed package's public `getPostgresMigration({ schema: 'northstar' })` API. Setup commits each migration ledger update in the same transaction as its SQL. Runtime entrypoints never apply migrations. Follow the package's migration guidance before changing its pinned version.

Publication idempotency and business idempotency have different jobs. This app permanently associates each order request key with its normalized customer, SKU, and quantity. Repeating the same request returns its order; changing the request with the same key returns `409`. The webhook publisher independently deduplicates its publication key. Warehouse receipts independently deduplicate the received event ID.

The package stores signing material for delivery. The app also retains the one-time receiver secret encrypted with its persistent host key, then shares that storage with the local receiver. The HTTP state API never returns that secret. The first connection uses an app advisory lock; if a process dies after endpoint creation but before saving the receiver secret, another connection can recover the matching endpoint through the public rotation API.

## Local security boundary

This demo binds its HTTP servers to loopback. The shop validates the Host header, rejects foreign browser origins on mutations, and requires JSON. Those checks support local browser use. They are not user authentication. The receiver accepts only signatures verified against the configured secret and checks the original request body before reading the event.

Before using this pattern in a deployed app, add authenticated administration, owner authorization, HTTPS, a secure receiver secret handoff, and suitable secret storage. Choose retries and retention for the business. Treat stored payloads and receiver responses as application data. The Compose password is only for this loopback demo.

Read [FINDINGS.md](FINDINGS.md) for observed integration friction and the verification boundary. Package references: [installation](https://good-webhooks.vercel.app/getting-started/installation), [transactions](https://good-webhooks.vercel.app/delivery/enqueue), [workers](https://good-webhooks.vercel.app/operations/workers), and [receivers](https://good-webhooks.vercel.app/delivery/receiving).
