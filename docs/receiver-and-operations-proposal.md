# Receiver and operations design

Status: implemented after three independent audits of scope, security, and TypeScript design against commit `3450f61`. The receiver parser, operational examples, and migration correction are complete. This document records their contract and the accepted audit findings. See the [receiver guide](receiving.md) and [operations guide](operations.md) for usage.

The v0 addition is one receiver parser and its result type. Database setup remains explicit. Worker execution keeps `run()` and `tick()`. Better examples carry the deployment guidance without introducing a scheduler, migration CLI, receiver factory, or adapter ecosystem.

## Receiver schemas describe the transmitted payload

`parseWebhook()` takes the existing verifier inputs and a required event-schema map. It authenticates the raw body, checks the Good Webhooks envelope, validates its payload, and returns a typed result. It does not deduplicate events, choose an HTTP response, or execute business work.

```ts
const event = await parseWebhook({
  body: rawBody,
  headers: request.headers,
  secret: endpointSecret,
  events: receiverEvents,
})

if (event.type === 'invoice.paid') {
  event.data.invoiceId
  event.data.amount
}
```

The receiver map defines the accepted event names. Each validator accepts the JSON transmitted in `data`. The parser calls the selected validator's `~standard.validate()` once, awaits its result, and returns its output without revalidation. Standard Schema permits asynchronous validation and distinguishes input from output types. [Standard Schema specification](https://standardschema.dev/)

The result preserves the relationship between each event name and its decoded payload:

```ts
type ParsedWebhook<E extends EventDefinitions> = {
  [K in Extract<keyof E, string>]: {
    id: string
    type: K
    occurredAt: string
    data: StandardSchemaV1.InferOutput<E[K]>
  }
}[Extract<keyof E, string>]
```

The runtime returns `result.value` from validation. It must not cast the original parsed JSON to this output type. Receiver output may contain local values such as `Date`, so the producer's JSON serialization restrictions do not apply to decoded output.

Both `parseWebhook()` and `ParsedWebhook` belong in the existing `/verify` export beside `verifyWebhook()`. That import must load no database, worker, or transport module. The existing verifier remains unchanged publicly and continues supporting caller-owned payload formats. Standard Webhooks does not require this library's JSON envelope. [Standard Webhooks payload specification](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md#payload)

## Shared schemas must preserve transmitted values

The main example uses a standalone `events.ts` containing validators for the transmitted JSON. It imports no server configuration, database pool, or secrets. Preserve inference with an inferred object, optionally constrained with `satisfies EventDefinitions`. Do not annotate that object as `EventDefinitions`, which widens its event names and payload types.

Normalize domain inputs before publishing when sharing validators between sender and receiver. A producer schema that converts dollars to cents can otherwise convert `42` to `4200` on publication and `4200` to `420000` on receipt. Matching input and output types does not make a transformation safe to repeat.

Existing producer transformations remain supported. Those applications supply a separate receiver map that describes the transmitted output. Receiver-only transformations are also allowed. The schema provider controls how often it invokes its own callbacks. Keep transforms free of business side effects. The [receiver guide](receiving.md#use-asynchronous-zod-schemas-safely) documents the installed Zod version's async probe behavior and the tested application-level workaround. No automatic output-validator derivation, inverse transformation, paired-schema abstraction, or identity check is included.

Keep an existing event name backward compatible with retained events. Use a new name such as `invoice.paid.v2` for a breaking payload change. Deploy receiver support before enabling new producer events and subscriptions. Retain old receiver schemas while old events can still be retried or replayed. Sharing the latest schema module does not update previously stored event bodies.

## Parsing establishes one authenticated event identity

The parser's contract is:

1. Snapshot the raw input and relevant headers. Enforce a fixed 512 KiB raw-envelope limit before signature work. This accommodates the producer's maximum 256 KiB payload plus its envelope.
2. Verify the exact signed bytes before JSON parsing or invoking an event validator. Reuse one private verification implementation and its verified header snapshot. Byte input requires strict UTF-8 decoding after verification.
3. Require a JSON object with own `id`, `type`, `occurredAt`, and `data` fields. Require string identifiers and a valid ISO timestamp in the producer's UTC format. `data` must exist even if its validator accepts `undefined`.
4. Require the body ID to equal the verified `webhook-id`. Freshness applies only to the signed attempt timestamp. An old `occurredAt` remains valid during a fresh retry or replay and is returned as a string.
5. Validate the raw JSON payload against the producer's existing size, finite-number, and depth limits before invoking a schema. Those bounds apply to received JSON, not decoded validator output.
6. Resolve the event schema through an own-property lookup. Reject unknown event names. Await the selected validator and construct a new result with the authenticated metadata and validated output.

Extra envelope fields are accepted and omitted from the returned result. Payload unknown-field behavior belongs to the selected validator. The parser neither infers an owner from the payload nor authorizes access to a scope.

The HTTP host must enforce its request-size limit before buffering the body. A parser receiving an already allocated string or byte array cannot enforce an upload limit retrospectively. The receiver example must demonstrate that distinction and use an endpoint secret from trusted configuration.

## Request failures and receiver failures remain distinguishable

The parser preserves `SIGNATURE_INVALID` and `SIGNATURE_EXPIRED`. Add one expected-input code, `PAYLOAD_INVALID`, for malformed encoding or JSON, invalid envelopes, bound violations, unknown event names, and validator-reported issues. Messages remain bounded and contain no payload values or raw validation issue text.

Thrown or rejected validator exceptions are unexpected receiver failures. Wrap them in an ordinary error with their original cause, even if the validator threw a `WebhookError`. This prevents a validator exception from accidentally masquerading as a parser-generated request rejection.

The receiver example maps the three expected request-error codes to an appropriate `4xx` response. Invalid trusted configuration and unexpected validator or business-processing failures produce `5xx`. It acknowledges success only after durable receiver work completes. Deduplication and the business mutation share the host's transaction.

Unknown-event rejection can be terminal with the current delivery policy. The parser has no silent ignore mode. Hosts needing a different dispatch policy can use `verifyWebhook()` and their own parsing.

## The application owns migration transactions

Packaged SQL contains no `BEGIN` or `COMMIT`. The application's runner executes the SQL and its migration bookkeeping in one transaction on one connection. Standalone setup uses `psql --single-transaction -v ON_ERROR_STOP=1`.

The audit reproduced the old file committing its caller's transaction. A later `ROLLBACK` left a preceding marker row committed. PostgreSQL treats an inner `BEGIN` as a warning, not as a nested transaction. [PostgreSQL 16 transaction documentation](https://www.postgresql.org/docs/16/sql-begin.html)

The host's migration ledger tracks execution order. `webhook_schema_version` in the configured PostgreSQL schema records compatibility for `check()`. Published migration files become immutable; later schema changes append migrations. At the time of this design's implementation, the unpublished schema was a fresh-install baseline, with no automatic conversion of older prototype data. See the current [migration guide](../apps/docs/content/docs/operations/migrations.mdx) for release requirements.

No new migration API, CLI, ORM integration, or runtime DDL is needed.

## The worker example owns its process lifecycle

The worker entry point imports an inert configuration module. It installs signal and pool-error handling before startup I/O, checks persistent configuration and schema, awaits `worker.run()`, and closes its pool in `finally`, including when startup fails.

The default recipe omits `onError`. An unexpected worker or pool failure produces a nonzero exit status after cleanup. The host's process supervisor supplies restart backoff. Normal receiver failures already use the delivery retry policy and remain visible in history.

Logging and continuing through `onError` remains an explicit alternative. It is not the default production recipe: a wrong but correctly formatted encryption key can otherwise leave the process alive while every claim fails.

Configure finite database connection and statement timeouts. Document the supervisor's final shutdown deadline. Aborting the worker interrupts HTTP work but does not cancel every database operation or prove that a receiver did not process a request. The pool can wait for checked-out clients during closure. [node-postgres pool documentation](https://node-postgres.com/apis/pool)

Process integration tests exercise startup failure, worker failure, pool errors, normal termination, and termination during delivery. It introduces no worker-hosting abstraction or hidden background process.

## Cleanup needs a bounded schedule with enough capacity

An adjacent cleanup example runs `worker.prune()` in a sequential loop with a fixed batch or time budget. Each call deletes at most 100 events. Stop the current run on zero progress or budget exhaustion, then retry through the host's schedule. A zero or short batch under contention does not prove that all expired history is gone.

Choose a cadence whose deletion capacity exceeds the rate at which events expire. Report errors and repeated budget exhaustion. Retention is an eligibility threshold, not a guaranteed deletion deadline. Pruning removes history and replay data and releases the deleted events' publication idempotency keys.

Pruning remains explicit and independent of `run()`. No timers or scheduling framework enter the core.

## Acceptance and audit disposition

The migration defect is corrected in the current revision, with a regression covering failure, rollback of schema and bookkeeping, and successful retry. The parser and examples have these acceptance requirements, covered by the runtime tests, compile-time assertions, and packed-consumer checks:

- Compile positive and negative examples for multiple event names, discriminated payloads, and transformed receiver output. Exercise asynchronous validation and a shared value-preserving schema through a complete publication-to-parser round trip.
- Cover missing fields, malformed bodies, bad signatures, header/body ID mismatch, unknown and inherited names, legitimate own names such as `constructor`, and old events with fresh retry signatures. Invalid signatures must never invoke a schema.
- Accept every maximum-sized producer envelope. Reject oversized, excessively deep, non-finite, and invalidly encoded inputs before schema execution. Test the HTTP upload limit separately.
- Distinguish validator issue results from thrown exceptions, including exceptions shaped like expected library errors. Verify that examples preserve retries for unexpected server failures.
- Install a packed package and verify receiver-only imports and types without loading server modules. Cover both supported header representations, raw strings and bytes, and rotated secrets.
- Run worker and cleanup examples against a dedicated disposable database. Cover bad configuration, missing schema, wrong encryption keys, pool failures, database stalls, shutdown, multiple cleanup batches, and deferred records with active leases.

All three audits support the existing database and worker interfaces and a single receiver parser. Accepted revisions address transaction ownership, double transformations, correlated output types, authenticated envelope identity, input bounds, error classification, event evolution, worker failure policy, and cleanup capacity. Receiver factories, automatic schema conversion, event registries, arbitrary envelope formats, HTTP adapters, and migration infrastructure remain deferred.

The independent audits included source and specification inspection and focused transform reproductions. The coordinator separately reproduced the migration failure on disposable PostgreSQL 16. Runtime verification covers the parser, HTTP receiver, durable demo, and spawned worker and cleanup processes. The host still owns its supervisor restart policy and final shutdown deadline; those deployment settings are documented, not provisioned by the package.
