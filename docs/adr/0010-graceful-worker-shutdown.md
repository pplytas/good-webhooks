---
status: accepted
---

# Allow active attempts to finish during worker shutdown

Normal worker shutdown stops new claims and allows active delivery attempts to finish within a configurable grace period before requesting cancellation. This reduces avoidable duplicate retries during routine restarts, at the cost of a slower shutdown. The host retains responsibility for database timeouts and the final process deadline because cancellation cannot guarantee that every database or provider operation has stopped.

Accepted on 8 October 2026. Implemented with a 30-second default grace period on `run()` and `runOnce()`, with zero for immediate cancellation.
