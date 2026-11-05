---
status: accepted
---

# Ship 1.0.0 without two outside integrations

The 1.0 gate in the roadmap asks for two integrations outside the maintainer's apps, with their feedback incorporated, or a written decision to ship without them. On 5 November 2026 there are none: no public repository depends on the package, and the outreach that would find adopters (the Show HN launch and the design-partner notes) has not started. Nothing guarantees two integrations by any date, so waiting for them would leave 1.0.0 without a ship date.

1.0.0 ships after the release candidate's four-week hold, on or after 1 December 2026, without outside integrations.

What stands in for outside feedback:

- The Playground has run every release since 0.1.0 as a public deployment with real endpoints and failing receivers, and its findings are logged on issue #74.
- The two examples, an order service and a Better Auth billing app, are built and tested against each release.
- The 0.7.0 proof covers large history, many workers under faults, and a 72-hour soak with worker and PostgreSQL restarts.
- The host-implemented interfaces were reviewed and frozen in #163, with the public API recorded in a checked report.

The cost is that the first outside teams may find an interface that fits their stack badly after the API is frozen. The 1.x policy lets most fixes land as additions: new optional members, new options, new exports. A fix that needs a breaking change waits for 2.0. The release candidate stays available on the `rc` tag until 1.0.0, so any team that tries it before then can still shape the release.

Accepted on 5 November 2026 for `1.0.0`.
