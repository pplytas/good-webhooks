---
status: accepted
---

# Send test events from management, outside delivery

Endpoint management sends a test event itself, in the caller's request: `sendTestEvent(scope, id)` signs a fixed payload with the endpoint's live secrets, sends it once, and returns the receiver's answer. It creates no event or delivery record, never retries, does not count toward automatic pause, and works on paused endpoints. This keeps the feature available wherever management is, including Better Auth management without PostgreSQL delivery ([ADR 0004](0004-management-without-delivery.md)), and gives an owner an answer while they wait. We rejected publishing the test through delivery: it would need delivery tables and a worker, the owner would have to poll for the outcome, and a test failure would count toward pausing the endpoint it is meant to check. The request goes out from the web process, so management now loads the Node transport, and URL checks match delivery: DNS answers are validated, the connection is pinned to the vetted address, and redirects are not followed.

The test event uses the type `good-webhooks.test`, and the `good-webhooks.` prefix is reserved: configuration rejects event names that start with it, so no application event can collide with one we send. `parseWebhook` accepts `good-webhooks.test` without the receiver's event map listing it and returns it as part of its result union. Otherwise every receiver built from our docs would reject the test with 400, and the owner would read a working receiver as broken. Receivers answer it with 2xx and skip processing. This is a contract with every receiver and is hard to take back, so later events of our own also go under the reserved prefix.

Accepted on 18 October 2026 for `0.3.0`.
