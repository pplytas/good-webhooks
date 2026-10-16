---
status: accepted
---

# Pause failing endpoints through management

The worker pauses an endpoint that has failed every attempt for a sustained period (five days by default) or answered HTTP 410. It does so through an optional `pause` method on `EndpointSource`, so the endpoint is paused in management and its owner sees one state and resumes it the usual way. This is the first write from delivery into management; [ADR 0007](0007-shared-management-provider.md) kept the source read-only. A hold kept only in delivery storage was rejected: management would report the endpoint as active while nothing was sent, and owners would need a second resume path.

The built-in PostgreSQL and Better Auth providers implement `pause`. A worker with automatic pausing on refuses to start (`run()` or `runOnce()` throws `INVALID_CONFIG`) when its source lacks `pause`; engines that only publish never need it, so construction does not check. The pause records a reason (`failing` or `gone`) on the endpoint and applies only if the endpoint has not changed since the failures were counted; resuming or changing the URL starts a new failure window. Worker hooks report each automatic pause on a best-effort basis, so the stored reason, not the hook, is the record.

Accepted on 16 October 2026 for `0.2.0`, which requires schema 5 and turns automatic pausing on by default. Applications opt out with `endpointHealth: false`.
