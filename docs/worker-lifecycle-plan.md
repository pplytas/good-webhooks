# Worker lifecycle alignment

Status: implemented and verified locally, 8 October 2026.

## Agreed decisions

- Keep publication and dispatch separate. The host can run the worker in the application process or in a separate process.
- Treat normal shutdown as a request to stop new claims and let active attempts finish during a configurable grace period. Request cancellation when that period expires. See [the shutdown decision](adr/0010-graceful-worker-shutdown.md).
- Continue processing immediately after a batch completes a prepared attempt as a success, retry, or terminal failure. Wait after an empty batch, a stale-only result, or an operational error when configured to continue. Paused endpoints and contention must not cause busy loops.
- Rename `worker.tick()` to `worker.runOnce()`. It processes one bounded batch, not the entire queue. Keep `worker.run()` for continuous processing and `worker.prune()` for explicitly scheduled retention cleanup.
- Defer a worker-only constructor and additional `start()` or `stop()` methods.
- Preserve receiver retry rules and the current operational error policy. Without `onError`, operational errors stop `run()`. With `onError`, the loop can continue after a delay unless the callback fails.

## Shutdown options

Use `shutdownGraceMs` on both `run()` and `runOnce()`, with a default of 30,000 milliseconds. Valid values are integers from 0 through 2,147,483,647. The grace period begins when the caller's signal aborts. A value of zero requests immediate cancellation. Both methods stop taking new work when their signal aborts.

Implementation, tests, examples, and public worker documentation use the agreed behavior.

## Implementation constraints

PostgreSQL connection and query methods have no cancellation contract. Endpoint-provider calls also have no signal parameter. Stopping the wait for a provider result does not cancel the underlying call. The grace period therefore determines when forced cancellation is requested, not when the process must have exited.

Worker shutdown must continue to await owned work and completion writes. The host configures database timeouts and supervises final termination. Forced cancellation can leave the receiver outcome unknown, so receivers still need durable deduplication.

Graceful shutdown does not extend delivery leases. Prepared attempts refresh their lease, and completion still requires a live lease and the matching claim token. The default request timeout is ten seconds and the default lease is sixty seconds.

## Verification

- Verify that `runOnce()` processes one bounded batch and replaces `tick()` without an alias.
- Exercise graceful completion, grace expiry, immediate cancellation, and signals aborted before the call on both execution methods.
- Verify that a stop during endpoint resolution creates no sending attempt and does not wait for the underlying provider call.
- Verify that productive batches continue immediately and empty, stale-only, and handled-error batches wait for the polling interval.
- Preserve exclusion between calls while the worker shuts down. Verify that completion writes can finish after the cancellation deadline.
- Check package declarations, runnable examples, public documentation, and existing delivery and retry behavior.

Local verification passed with PostgreSQL 17: all 377 tests, package type checks, fresh archive consumer checks, and the delivery/replay demo. Documentation type checks, static build, and internal link checks passed. Independent correctness and API reviews found no remaining blocking issues. CI also verifies PostgreSQL 16 and the Better Auth adapter matrix.
