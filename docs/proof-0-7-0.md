# 0.7.0 proof

The 1.0 gate item "0.7.0 proof published" is ticked from this page. Each row links to the published numbers, their method, and their caveats.

| Proof                        | Status                           | Evidence                                                                                                                  |
| ---------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| Large history with `prune()` | Published, `prune()` fix shipped | [Performance: large history](https://good-webhooks.dev/docs/operations/performance#large-history)                         |
| Multi-worker contention      | Published                        | [Performance: many workers under faults](https://good-webhooks.dev/docs/operations/performance#many-workers-under-faults) |
| 72-hour Playground soak      | Published, no library defect     | [Performance: 72-hour soak](https://good-webhooks.dev/docs/operations/performance#72-hour-soak)                           |

The large-history run found that `prune()` slowed with history on schema 6 ([#153](https://github.com/pplytas/good-webhooks/issues/153)). Schema 7 in 0.7.0 ships the index that fixes it ([#155](https://github.com/pplytas/good-webhooks/pull/155)).

Repeat the large-history and contention runs with the commands on the performance page. Each is a single run on one machine, so compare results on the same machine only.

The soak ran 12 restarts of the worker and PostgreSQL over 72 hours on the public Playground. Every invariant held, and the canary arrived on its next tick after every fault.
