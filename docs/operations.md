# Operate webhook delivery

This guide moved to the public documentation in `apps/docs/content/docs`.

- [Run workers and what failures do](../apps/docs/content/docs/operations/workers.mdx)
- [Inspect, replay, and prune history](../apps/docs/content/docs/operations/retries-and-replay.mdx)
- [Rotate keys](../apps/docs/content/docs/operations/key-rotation.mdx)
- [Apply migrations](../apps/docs/content/docs/operations/migrations.mdx)

Run `pnpm dev` from the repository root to read the rendered documentation.

## Where each failure claim is checked

The failure table in [Run workers](../apps/docs/content/docs/operations/workers.mdx#what-failures-do) rests on these tests in `packages/good-webhooks`.

| Claim                                                             | Test                                                                                                    |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Crash after acceptance delivers again                             | `test/worker.test.ts`, "recovers a crash after receiver acceptance"                                     |
| Expired tokens are fenced                                         | `test/worker.test.ts`, "fences an expired token before and after a replacement claim"                   |
| Retry and permanent-failure status codes                          | `test/worker.test.ts`, "retries HTTP" and "fails permanently on HTTP 410"                               |
| Timeout and stalled responses retry                               | `test/worker.test.ts`, "retries a timed out request" and the partial-response cases                     |
| A delivery that waits behind a pause keeps its full retry window  | `test/pause-window.test.ts`, "retries a delivery that waited behind a pause longer than retry.maxAgeMs" |
| Wrong key consumes no attempt                                     | `test/operations.test.ts`, "exits nonzero on a worker failure without consuming an attempt"             |
| Mid-transaction and idle disconnects                              | `test/operations.test.ts`, "handles a database disconnect" and "idle-pool connection error"             |
| Blocked startup and stalled handshake bound                       | `test/operations.test.ts`, "bounds a blocked startup statement" and "never completes startup"           |
| `SIGTERM` finishes the active delivery                            | `test/operations.test.ts`, "finishes an active delivery on SIGTERM before closing the pool"             |
| Grace period and cancellation timing                              | `test/worker-lifecycle.test.ts`, "worker shutdown deadlines"                                            |
| `SIGKILL` recovery with a backlog                                 | `scripts/check-operations.mjs` (`pnpm test:operations`)                                                 |
| Killed connections, exclusive lock, failing and hanging receivers | `scripts/check-chaos.mjs` (`pnpm test:chaos`)                                                           |
| Old and new packages across an upgrade                            | `scripts/check-upgrade-compat.mjs` (`pnpm test:compat`)                                                 |

## Export metrics with OpenTelemetry

`packages/good-webhooks/examples/operations/otel.ts` maps the delivery hooks to OpenTelemetry metrics and depends only on `@opentelemetry/api`. It records an attempt duration histogram in seconds and counters for attempts by outcome, responses by status class, and automatic pauses by reason. `test/otel-recipe.test.ts` checks the recorded values and attributes with a fake meter and the API's no-op meter. A docs-site page follows in the 0.5.0 release.
