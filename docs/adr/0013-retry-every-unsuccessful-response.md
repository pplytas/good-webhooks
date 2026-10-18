---
status: accepted
---

# Retry every unsuccessful response except 410

The worker retries every attempt that does not end in a 2xx response, including 3xx and 4xx, until `retry.delaysMs` or `retry.maxAgeMs` runs out. Only HTTP 410 ends a delivery at once, because the Standard Webhooks specification treats it as the receiver withdrawing, and it already triggers an automatic pause ([ADR 0012](0012-automatic-pause-through-management.md)). It ends the delivery even with `pauseOnGone: false`. Destinations the sender rejects itself (`unsafe_url`) and requests it cannot build (`invalid_request`) also stay permanent. `Retry-After` is still honored only on 429 and 503. Before `0.3.0`, 4xx responses other than 408, 425, and 429 failed after one attempt.

A status code describes one request, not the receiver's intent. Edges, proxies, and DNS changes answer 404, 403, or 401 during a domain cutover or a deploy, and a receiver with a stale signing secret or event map answers 400 until its owner fixes it. The Playground lost its canary's first event to a transient 404 this way ([#74](https://github.com/pplytas/good-webhooks/issues/74)). Retrying turns these into delays. [Svix](https://docs.svix.com/retries) and [Stripe](https://docs.stripe.com/webhooks) also retry every non-2xx response, as their documentation stated on 17 October 2026.

The cost is up to seven attempts per delivery with the default schedule, where one was enough before, to a receiver that keeps rejecting. Automatic pause is unchanged, because it measures how long every attempt has failed, not how many attempts were made. We rejected a configurable list of retryable statuses: nobody has asked for one, and it would make the receiver contract depend on each sender's configuration. A receiver that wants no more attempts for an event answers 2xx and discards it; one that wants no more events answers 410.

Accepted on 18 October 2026 for `0.3.0`.
