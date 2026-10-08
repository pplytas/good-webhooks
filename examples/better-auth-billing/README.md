# Better Auth billing example

A local billing app that manages personal invoice webhooks through Better Auth. It uses `good-webhooks@0.1.0-alpha.2` from npm, with its own lockfile and no workspace imports.

## Run

Requires Node.js 24+, npm, and Docker Compose. Run these commands in this directory:

```sh
npm ci
docker compose up -d --wait
npm run setup
npm run dev
```

Open [Ledger desk](http://127.0.0.1:4312). Use that exact address. The app requires the configured origin for mutations and binds to loopback.

1. Create an account with a made-up email and a demo password.
2. Create an endpoint. The typed Better Auth client calls the plugin's authenticated management routes.
3. Copy the one-time signing secret if needed, then click **Transfer to local receiver**. The demo stores an encrypted receiver copy. If you leave before transferring it, remove the endpoint and create another.
4. Create an invoice. Its delivery and the receiver's recorded invoice appear on the right.
5. Record payment to send `invoice.paid`.
6. Click **Reject deliveries**, then create another invoice. Inspect its three HTTP 503 attempts. Click **Restore receiver**, then **Replay** on the failed delivery.
7. Replay a successful delivery. The receiver reports **duplicate** and leaves the existing business outcome unchanged.

Pause, resume, and remove endpoints from the left column. A second account has separate invoices, endpoints, delivery history, and receiver controls. The history view shows the latest 50 deliveries and receiver requests, and the latest 100 invoices.

No payment processor is connected. Recording payment updates this local database only.

## Processes and storage

`npm run dev` supervises three processes and stops all of them if one exits. It builds the browser client once. Restart it after editing code. You can also run each process in a separate terminal:

```sh
npm run build
npm start
npm run receiver
npm run worker
```

The app listens on `127.0.0.1:4312`, the receiver on `127.0.0.1:4412`, and PostgreSQL on `127.0.0.1:55442`. Compose stores this example's database in its own named volume. `docker compose down` stops it and retains data.

`npm run setup` creates `.env` once with persistent auth and receiver-encryption secrets. If you supply database, port, or secret environment variables on the first run, setup saves those values. Subsequent runs preserve the existing file. Keep both secrets when restarting: Better Auth encrypts endpoint signing material with the auth configuration, and the receiver uses its separate encryption key. Never commit `.env`.

Setup explicitly applies Better Auth's `getMigrations()` result, Good Webhooks' **delivery-only** migration, and the app's SQL schema. It refuses a populated database without the example's marker. Startup checks the delivery schema and does not migrate. Do not point this example at an existing application's database.

Ports and the database URL can be changed in `.env`. Keep the database host on loopback. The receiver URL in each endpoint includes a unique route ID. Receiver controls are authenticated app routes; the receiver accepts signed webhook requests only.

## Ownership boundaries

| Component                      | Responsibility                                                                                                                             |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Better Auth and `goodWebhooks` | Sign-up, sessions, personal endpoint authorization, endpoint storage and secret encryption                                                 |
| Billing app                    | Authorize invoice actions, derive user scope from the session, commit business writes and publication on one checked-out PostgreSQL client |
| Good Webhooks delivery         | Persist events, select endpoint recipients, sign requests, record attempts, retry and replay                                               |
| Separate worker                | Initialize the same auth options and management database, then explicitly run the delivery loop                                            |
| Local receiver                 | Verify raw bytes with `parseWebhook`, then commit the receipt and invoice outcome together; deduplicate by endpoint and event ID           |

The app and delivery tables share PostgreSQL so invoice writes and publication can commit atomically. Better Auth's recipient lookup uses its own adapter connection. That lookup is not part of the business transaction's snapshot. This example does not promise atomic coordination with concurrent endpoint changes.

The worker's retry delays are 1 and 3 seconds so failures are visible quickly. Unexpected worker errors terminate the process; the development supervisor stops its siblings. Shutdown allows prepared sends 3 seconds to finish and gives processes a final deadline.

The receiver is a second HTTP process, but shares the demo database and receives secrets through an app-owned local transfer route. In a deployed integration, the customer owns the receiver and supplies its secret through their own secret-management workflow. The app exposes no delivery library objects or trusted management methods directly to the browser.

## Verify

```sh
npm run typecheck
npm run build
npm test
```

Tests use `TEST_DATABASE_URL`, or `DATABASE_URL` from `.env`, to connect to PostgreSQL. The role needs permission to create a database. Each run creates a uniquely named `billing_test_*` database, runs migrations, and drops only that database when done. It never resets the demo database. Docker commands are not part of the test runner.

For CI, supply a PostgreSQL 16 service connection:

```sh
TEST_DATABASE_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres npm test
```

The HTTP suite starts app and receiver listeners on temporary loopback ports and runs the continuous worker in a child process. It covers authentication, scope and user isolation, origin checks, secret transfer, signed delivery, payment, rollback, retry exhaustion, replay, durable deduplication, invalid signatures, pause/resume/removal, and sign-out/sign-in.

See [FINDINGS.md](./FINDINGS.md) for the integration notes from consuming the published package.
