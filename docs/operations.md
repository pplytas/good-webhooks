# Run workers and clean up history

The application owns worker processes, database configuration, migrations, and cleanup scheduling. These examples use the existing `worker.run()` and `worker.prune()` APIs. They create no HTTP management server or scheduler.

## Prepare persistent configuration

Use Node.js 24 or later and PostgreSQL 16 or later. From a checkout with dependencies installed, build the package:

```sh
npm run build
```

Set `DATABASE_URL` to the database that holds the application's webhook tables. Set `WEBHOOK_ENCRYPTION_KEY` to the same persistent key used by every producer and worker. These examples require both values and never generate a temporary key or choose a default database.

Apply the package's SQL migration once through your migration runner. For a fresh database in a checkout:

```sh
psql "$DATABASE_URL" --single-transaction -v ON_ERROR_STOP=1 -f migrations/001-initial.sql
```

The host owns the migration transaction and ledger. Neither example applies DDL. Both call `check()` before work starts.

The [configuration module](../examples/operations/config.ts) is inert on import. It reads environment variables only when an entry point calls `readOperationsConfig()`. Its event map comes from the [shared example schemas](../examples/basic/events.ts). Replace that map with your application's event definitions.

## Start and stop a worker

Run the [worker entry point](../examples/operations/worker.ts) under your process supervisor:

```sh
node examples/operations/worker.ts
```

After the schema check, the process emits `webhooks.worker.started` and awaits `worker.run()`. `SIGTERM` and `SIGINT` request shutdown. The entry point waits for the worker to settle, closes its pool, and emits `webhooks.worker.stopped` on a normal exit.

Signal handlers and database-error listeners exist before startup I/O. The pool listener handles idle connections. Each checked-out client also has an error listener until release. Configuration errors, schema failures, unexpected worker failures, and database errors produce a `webhooks.worker.failed` record and a nonzero exit status after cleanup. A correctly formatted but incorrect encryption key fails when the worker first claims an encrypted endpoint.

The example omits `onError`, so unexpected errors stop the process. Configure restart backoff in your supervisor. If your application supplies `onError` to log and continue instead, it also needs monitoring that detects workers making no delivery progress. Ordinary receiver failures already use the delivery retry policy.

An abort interrupts active HTTP requests. It does not cancel every PostgreSQL statement or prove that a receiver did not process a request. Interrupted delivery attempts record an unknown receiver outcome and may be retried. Receivers still need durable deduplication.

Set a final shutdown deadline in the supervisor. A 45-second termination grace period is a starting point for the default timeouts below. At that deadline, the supervisor must terminate the process if it remains alive. Increase the grace period if you raise database timeouts or add shutdown work. This deadline is a host policy, not a guarantee from `AbortSignal` or `pool.end()`.

## Bound database waits

The examples use these connection settings:

| Setting                              | Default                         | Environment override               |
| ------------------------------------ | ------------------------------- | ---------------------------------- |
| Connection and pool checkout timeout | 5 seconds                       | `WEBHOOK_DB_CONNECT_TIMEOUT_MS`    |
| PostgreSQL statement timeout         | 10 seconds                      | `WEBHOOK_DB_STATEMENT_TIMEOUT_MS`  |
| Client query timeout                 | Statement timeout plus 1 second | Derived from the statement timeout |
| Idle transaction timeout             | Statement timeout               | Derived from the statement timeout |
| Maximum pool connections per process | 10                              | Edit the example configuration     |
| Worker poll interval                 | 1 second                        | `WEBHOOK_POLL_INTERVAL_MS`         |

These bounds help processes exit after connection failures and blocked statements. A client query timeout does not guarantee cancellation of the server's query. Pool closure can wait for checked-out clients, so retain the supervisor deadline. Budget total database connections across producers, workers, and scheduled cleanup jobs. See the [node-postgres pool contract](https://node-postgres.com/apis/pool) and [client timeout settings](https://node-postgres.com/apis/client).

For local development receivers only, set `WEBHOOK_ALLOW_LOCALHOST=true`. The default rejects private destinations and loopback HTTP. The flag does not permit arbitrary private networks.

## Schedule bounded cleanup runs

Run the [cleanup entry point](../examples/operations/cleanup.ts) from your host's scheduler:

```sh
node examples/operations/cleanup.ts
```

Each run calls `prune()` sequentially. The default limits are 20 batches or 30 seconds, whichever stops the loop first. Override them with `WEBHOOK_CLEANUP_MAX_BATCHES` and `WEBHOOK_CLEANUP_MAX_DURATION_MS`. The time budget is checked between batches, so one in-progress batch can overrun it within the database timeout bounds.

Each batch deletes at most 100 expired events, with their deliveries and attempts. A short positive batch continues the loop. A zero batch stops the run, as do a signal or budget exhaustion. The process closes its pool before reporting `webhooks.cleanup.finished` with the batch count, deletion count, and stop reason.

`no_progress` means that the last batch deleted nothing. It does not prove that no expired records remain. Locks and active delivery leases can defer records. Run cleanup again on its regular schedule.

Budget exhaustion emits `webhooks.cleanup.budget_exhausted` and still exits successfully. Alert on repeated exhaustion and on nonzero exits. A run can exhaust its budget on the final eligible batch, so exhaustion alone does not prove a backlog exists.

At 20 batches every minute, the theoretical capacity is 2,000 expired events per minute. Actual capacity can be lower because of query time, locks, or active deliveries. Choose a cadence and budget whose observed deletion capacity exceeds the rate at which events expire. Avoid overlapping scheduled runs and monitor the age and count of expired history in your database.

The default retention window is seven days. Retention determines when history becomes eligible for deletion, not a guaranteed deletion deadline. Pruning removes replay data and releases the deleted events' publication idempotency keys. Keep your business idempotency policy independent if keys must remain reserved longer than webhook history.

Cleanup covers every scope in the configured database and remains separate from worker execution. `run()` never calls `prune()`.

## Verify process behavior

The operational integration tests spawn the actual Node.js entry points. They use a dedicated disposable database, reset the webhook schema, and terminate only connections with the examples' application names.

```sh
npm run build
TEST_DATABASE_URL='postgres://postgres:password@127.0.0.1:5432/disposable_webhook_tests' \
	npm exec vitest run test/operations.test.ts
```

Never point `TEST_DATABASE_URL` at application data. These tests deliberately remove the schema, hold locks, and terminate database connections to exercise process failure and recovery paths.
