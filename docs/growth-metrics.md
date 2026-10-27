# Growth metrics

Set up on 27 October 2026 as item 3 of the [growth plan](roadmap.md#growth-plan). It gives the launch content a baseline to compare against.

## What is measured

The `Growth metrics` workflow (`.github/workflows/growth-metrics.yml`) runs every Monday at 06:00 UTC and on demand. It runs `scripts/growth-snapshot.mjs`, which collects:

| Field                                       | Source         |
| ------------------------------------------- | -------------- |
| `stars`, `forks`, `watchers`, `open_issues` | Repository API |
| `views_14d`, `clones_14d`                   | Traffic API    |
| `referrers_14d`, `paths_14d`                | Traffic API    |
| `npm`                                       | npm APIs       |
| `dependents`                                | "Used by" page |

Views and clones carry the 14-day totals plus one entry per day. Referrers and paths are the top entries for the same 14 days. The `npm` block holds the downloads for the 7 days ending two days before the run and the latest published version. The `dependents` block holds the repository and package counts from the GitHub "Used by" page, scraped because there is no API for them.

## Where the data lives

One JSON line per run is appended to `snapshots.jsonl` on the [`metrics` branch](https://github.com/pplytas/good-webhooks/blob/metrics/snapshots.jsonl). The branch holds only this file and a short README, and is never merged. Read it with `git show origin/metrics:snapshots.jsonl` or on GitHub.

The first line was taken by hand on 27 October 2026 with the same script, before the workflow had a token.

To take a snapshot locally:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/growth-snapshot.mjs
```

## Caveats

- The traffic endpoints need push access, and the built-in Actions token is refused.
  - The workflow reads `METRICS_GITHUB_TOKEN`, a fine-grained token with read-only Administration permission on this repository.
  - Renew it before it expires, or the weekly run fails.
- The traffic API keeps 14 days and the run is weekly, so consecutive snapshots overlap by 7 days.
  - Use the per-day entries, not the totals, to build a continuous series.
- Clone counts include CI, mirrors and bots, so they say little about people.
- The npm `last-week` alias returned a stale window in October 2026, so the script asks for an explicit date range.
  - npm publishes a day's count during the next day, so the window ends two days before the run.
- The dependents page counts repositories whose dependency graph GitHub has indexed.
  - Private repositories and lockfile-free projects are missing.
  - npmjs.com blocks scrapers, so its dependents tab is not used.
- The `ref=<channel>` rule in the roadmap is not measurable yet.
  - Vercel Web Analytics drops query parameters, and its UTM filters need the Plus plan.
  - GitHub referrers show the domain only.
  - A small custom event that records `ref` is the cheapest way to make it count.

## AI assistant prompts

Six fixed prompts check whether assistants recommend the library. Repeat them after each content push and record the outcome here.

1. I send webhooks from a Node and PostgreSQL app, which library should I use?
2. What is the best way to add outbound webhooks to a Next.js app with Postgres? I want retries and signed payloads.
3. Is there a TypeScript library that implements Standard Webhooks for sending webhooks, not just verifying them?
4. How do I let users of my Better Auth app register their own webhook endpoints?
5. What are open source, self-hosted alternatives to Svix that store deliveries in my own Postgres database?
6. I want to use the transactional outbox pattern for webhooks in Postgres with Node. Are there existing npm packages for this?

### Results

Method: each prompt is sent once to `claude -p` (Claude Code 2.1.311) from an empty directory. Only web search and fetch are allowed, so no repository context leaks in. A first attempt leaked the maintainer's identity and the prompt list into every run. The model then named the library in four answers. Those runs were discarded. Cursor, Codex and ChatGPT runs need their own accounts, so a person runs them.

| Date       | Tool        | Model           | Prompt | Recommended |
| ---------- | ----------- | --------------- | ------ | ----------- |
| 2026-10-27 | Claude Code | claude-opus-5-5 | 1      | No          |
| 2026-10-27 | Claude Code | claude-opus-5-5 | 2      | No          |
| 2026-10-27 | Claude Code | claude-opus-5-5 | 3      | No          |
| 2026-10-27 | Claude Code | claude-opus-5-5 | 4      | No          |
| 2026-10-27 | Claude Code | claude-opus-5-5 | 5      | No          |
| 2026-10-27 | Claude Code | claude-opus-5-5 | 6      | No          |

What the 27 October 2026 Claude Code answers named instead:

- Prompt 1: Svix, Graphile Worker, pg-boss, Hook0 and Convoy.
- Prompt 2: an outbox table with Graphile Worker or pg-boss, `standardwebhooks` for signing, or Svix.
- Prompt 3: the `sign()` method of `standardwebhooks`, the Svix server, or Hookdeck Outpost.
- Prompt 4: the Svix app portal, or a custom Better Auth plugin.
- Prompt 5: the Svix server, Outpost, Hook0 and Convoy.
- Prompt 6: pg-boss, Graphile Worker, pg-transactional-outbox and pg-trx-outbox.

Baseline: 0 of 6 Claude Code answers name the library. Five answers point at the official `standardwebhooks` package for signing and a Postgres job queue for retries, and the Better Auth answer points at Svix or a custom plugin. That is the gap the tutorial and the comparison page should close.
