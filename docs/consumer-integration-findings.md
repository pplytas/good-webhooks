# Published-package integration assessment

Both examples consume `good-webhooks@0.1.0-alpha.2` from npm with independent lockfiles. The implementations started from public guides and installed declarations. Neither needed private Good Webhooks APIs or changes to the library.

## What worked

- The combined factory keeps standalone endpoint management, transactional publication, and delivery inspection together. The order application passes its checked-out PostgreSQL client to `publish()` and rolls business data and publication back together.
- Better Auth's typed client handles authenticated endpoint operations. The billing application connects the same management provider to a separate worker and selects personal publication scope from the server session.
- The receiver verifier, durable event identity, and delivery history support a visible retry and replay walkthrough. A repeated event creates no additional warehouse shipment or invoice outcome.
- Explicit startup and migration ownership make the examples usable as separate app, receiver, and worker processes. The library starts no background process on import.

## Prioritized follow-ups

| Priority | Observation                                                                                                                                                      | Recommendation                                                                                                                                                                                                                         |
| -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| First    | A complete Better Auth integration spans authentication setup, endpoint management, delivery storage, scope selection, and worker startup across several guides. | Use the new [complete application guide](../apps/docs/content/docs/examples.mdx) and billing example as the continuous walkthrough. Keep the smaller guides focused on individual tasks.                                               |
| First    | Personal endpoint routes default to the session user, while root delivery operations use application scope. A consumer must connect these explicitly.            | Keep the `forScope({ type: 'user', id: sessionUserId })` call visible in examples and scope documentation. Show the publication's delivery count so a missing recipient is observable. Do not infer identity inside the delivery core. |
| Next     | The one-time signing secret needs an explicit receiver handoff and persistent receiver storage. Endpoint creation and host configuration can commit separately.  | Retain the examples' working handoff and recovery recipes. Consider a shorter receiver-setup guide after feedback from external integrations. A generic secret-distribution service is outside the package's current responsibilities. |
| Next     | Replay controls need to account for original versus replay deliveries and endpoint status. Pausing retains pending work.                                         | Use actual delivery and endpoint state to explain which operations are available. Keep the lifecycle rules close to the replay examples; no new convenience API is justified yet.                                                      |
| Later    | Introductory tutorials pin alpha.1 while these examples pin alpha.2. The releases have identical runtime behavior.                                               | Keep tested exact pins and clarify their baseline when the tutorials next change. Update them after rerunning the tutorial, rather than changing version strings alone.                                                                |

## Improvements made during this work

The examples now have a public entry point, independent installation instructions, committed lockfiles, and CI jobs against the registry package. Review found and fixed billing setup overrides that were not retained in `.env`, static-file paths that failed in directories containing spaces, and replay controls offered for ineligible endpoints. The order transaction no longer writes a provisional event ID. Browser checks caught polling that replaced unchanged controls; both UIs now retain unchanged markup. The billing workspace response no longer sends unused receipt payloads on every poll.

These were defects or unnecessary complexity in the new consumers. They are not reported as library defects. No library API change is proposed by this assessment.

## Evidence and limits

The order suite covers real separate app, receiver, and worker processes, concurrent request idempotency, rollback, signed delivery, invalid signatures, retry exhaustion, replay, durable deduplication after restart, pause/resume, and graceful worker shutdown. The billing suite covers sessions, personal scope isolation, endpoint authorization, invoice creation and payment, rollback, receiver secret transfer, failure/replay, and deduplication. Both also compile their browser clients against published declarations.

The browser walkthroughs exercise the displayed flows and responsive layouts. These checks establish local behavior on Node.js 24 and PostgreSQL 16. They do not establish throughput, internet delivery behavior, organization permissions, database failover, or production deployment readiness. Centaur adoption remains a separate evaluation.

See the individual records for details: [order fulfillment](../examples/order-fulfillment/FINDINGS.md) and [Better Auth billing](../examples/better-auth-billing/FINDINGS.md).
