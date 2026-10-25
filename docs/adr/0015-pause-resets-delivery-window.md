---
status: accepted
---

# A pause resets a waiting delivery's retry window

A delivery fails when it is older than `retry.maxAgeMs` (48 hours by default), and an automatic pause lasts five days, so every delivery queued behind an automatic pause failed on resume: the worker deferred it once a second while the endpoint was paused, then failed it at the first reservation after the resume, without an attempt. The Playground showed 288 such deliveries per paused endpoint on 24 October 2026. A paused endpoint is "temporarily ineligible for new sending attempts" with its subscriptions in effect, so pausing must not lose work.

From schema version 6 each delivery records `window_started_at`. It starts at the delivery's creation, and the schema 6 upgrade SQL sets it to `created_at` for every existing delivery, so a 0.4.x delivery keeps the age it already had. When the worker defers a delivery because its endpoint is paused, it clears the column; when it next sees the endpoint active, it sets the column to that moment. The age check reads `window_started_at` instead of `created_at`, so a delivery that waited out a pause has its full `retry.maxAgeMs` again, with its attempt count and schedule unchanged. `retentionMs` still bounds everything.

We rejected two alternatives. Accumulating the exact paused time needs two columns and a rule nobody can state in one sentence. Cancelling queued deliveries on pause and relying on bulk replay would punish owner pauses, which are often minutes long, and would make every resume a two-step chore. The reset is more generous than an exact clock by at most one retry window, which is acceptable.

Accepted on 25 October 2026 for `0.5.0`.
