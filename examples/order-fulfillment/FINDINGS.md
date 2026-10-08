# Integration findings

This application consumes `good-webhooks@0.1.0-alpha.3` from npm. It was initially built against alpha.2 using public guides and installed declarations. Implementation did not require reading library internals or importing private files. The lockfile resolves the package from `registry.npmjs.org`.

## Observed friction

Manual use beyond the initial walkthrough found a library defect in alpha.2: delivery IDs sort as text, so `9` precedes `43`, history pagination skips records, and the demo selects an older delivery after saving an order. Alpha.3 sorts the numeric column and has digit-boundary regression tests. This example now pins alpha.3 and checks the ordering through its HTTP integration suite. See the [combined assessment](../../docs/consumer-integration-findings.md#delivery-history-defect).

| Severity | Observation                                                                                              | Evidence and handling                                                                                                                                                                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Low      | The first-delivery tutorial pins `0.1.0-alpha.1`, while this example pins the corrected `0.1.0-alpha.3`. | Rerun the tutorial against alpha.3 before updating its exact pin.                                                                                                                                                                                                                                   |
| Low      | A persistent receiver needs an app-owned way to retain and hand off the one-time signing secret.         | `endpoints.create()` returns `{ endpoint, secret }`; later endpoint reads return no secret. This example encrypts the secret in its own receiver configuration table and reuses it after restart.                                                                                                   |
| Low      | Endpoint creation and host receiver configuration are separate commits.                                  | The public endpoint-management methods do not accept a host transaction. This example serializes first-time connection with an advisory lock and recovers an interrupted connection using endpoint lookup plus public secret rotation. Business order publication does accept the host transaction. |
| Low      | Replay controls need the lifecycle rules from the guide, not only the method name.                       | A replay is eligible only for an original succeeded or failed delivery with an active endpoint. A replay has a new delivery ID but the same event ID. The app uses the returned delivery and the warehouse deduplicates the event.                                                                  |

These are integration responsibilities and small documentation/navigation costs. They are not claimed package defects.

## What worked

The published package installed in an independent npm package without a workspace link. Node 24 runs the TypeScript entrypoints directly. TypeScript checks the event map and transactional publish call against installed declarations. The public migration generator supplies standalone management and delivery SQL for an app-selected PostgreSQL schema.

The real HTTP/PostgreSQL tests exercise signed delivery, atomic rollback, concurrent order idempotency, short retries through failure, replay, durable receiver deduplication, paused delivery, process restart, and graceful shutdown. The tests query app-owned tables and public webhook APIs, not package-private tables.

A host-level test initially tried overriding the Host header through Node's Fetch client. Fetch did not send the requested override, so that assertion observed the normal local request. The test now uses `node:http` for this case. This was a test client issue, not evidence of a server boundary failure.

## Boundaries

This example verifies one loopback environment and PostgreSQL 16. It does not verify deployed authentication, internet destinations, multiple worker processes, database failover, key rotation across independently deployed receivers, or production shutdown under database failure.

The app has one warehouse endpoint and a fixed product catalog. It does not imply exactly-once network delivery. The warehouse's unique event receipt and shipment transaction prevent repeated business work when the same signed event arrives more than once.
