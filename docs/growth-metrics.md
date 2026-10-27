# Growth metrics

Set up on 27 October 2026 as item 3 of the [growth plan](roadmap.md#growth-plan). It gives the launch content a baseline to compare against.

## What is measured

The `Growth metrics` workflow (`.github/workflows/growth-metrics.yml`) runs every Monday at 06:00 UTC and on demand. It runs `scripts/growth-snapshot.mjs`, which collects:

| Field                                            | Source                                                                                               |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------------------- |
| `stars`, `forks`, `watchers`, `open_issues`      | GitHub repository API                                                                                |
| `views_14d`, `clones_14d`                        | GitHub traffic API, totals plus one entry per day for the last 14 days                               |
| `referrers_14d`, `paths_14d`                     | GitHub traffic API, top referrers and paths for the last 14 days                                     |
| `npm.downloads_7d`                               | npm downloads API for the 7 days ending yesterday, plus `latest_version` from the registry           |
| `dependents.repositories`, `dependents.packages` | The GitHub "Used by" page (`/network/dependents`), scraped, because there is no API for these counts |

## Where the data lives

One JSON line per run is appended to `snapshots.jsonl` on the [`metrics` branch](https://github.com/pplytas/good-webhooks/blob/metrics/snapshots.jsonl). The branch has no other content and is never merged. Read it with `git show origin/metrics:snapshots.jsonl` or on GitHub.

The first line was taken by hand on 27 October 2026 with the same script, before the workflow had a token. Baseline on that day: 4 stars, 4 forks, 64 views and 7,667 clones in 14 days, 510 npm downloads in 7 days, 0 dependents.

To take a snapshot locally:

```sh
GITHUB_TOKEN=$(gh auth token) node scripts/growth-snapshot.mjs
```

## Caveats

- The traffic endpoints need push access. The built-in Actions token is refused, so the workflow reads `METRICS_GITHUB_TOKEN`, a fine-grained token with read-only Administration permission on this repository. Renew it before it expires, or the weekly run fails.
- The traffic API keeps 14 days and the run is weekly, so consecutive snapshots overlap by 7 days. Use the per-day entries, not the totals, to build a continuous series.
- Clone counts include CI, mirrors and bots, so they say little about people.
- The npm `last-week` alias returned a stale window in October 2026, so the script asks for an explicit date range.
- The dependents page counts repositories whose dependency graph GitHub has indexed. Private repositories and lockfile-free projects are missing. npmjs.com blocks scrapers, so its dependents tab is not used.
- The `?ref=<channel>` rule in the roadmap is not measurable yet: Vercel Web Analytics drops query parameters, and its UTM filters need the Plus plan. GitHub referrers show the domain only. Adding a small custom event that records `ref` is the cheapest way to make it count.

## AI assistant prompts

Six fixed prompts check whether assistants recommend the library. Repeat them after each content push and record the outcome here.

1. I send webhooks from a Node and PostgreSQL app, which library should I use?
2. What is the best way to add outbound webhooks to a Next.js app with Postgres? I want retries and signed payloads.
3. Is there a TypeScript library that implements Standard Webhooks for sending webhooks, not just verifying them?
4. How do I let users of my Better Auth app register their own webhook endpoints?
5. What are open source, self-hosted alternatives to Svix that store deliveries in my own Postgres database?
6. I want to use the transactional outbox pattern for webhooks in Postgres with Node. Are there existing npm packages for this?

### Results

Method: each prompt is sent once to `claude -p` (Claude Code 2.1.311) from an empty directory with only web search and fetch allowed, so no repository context leaks in. A first attempt leaked the user's identity and the prompt list, and the model then named the library in four answers. Those runs were discarded and are not counted. Cursor, Codex and ChatGPT runs need their own accounts, so a person runs them.

| Date       | Tool, model                  | Prompt | Library recommended | What was named                                                         |
| ---------- | ---------------------------- | ------ | ------------------- | ---------------------------------------------------------------------- |
| 2026-10-27 | Claude Code, claude-opus-5-5 | 1      | No                  | Svix, Graphile Worker, pg-boss, Hook0, Convoy                          |
| 2026-10-27 | Claude Code, claude-opus-5-5 | 2      | No                  | Outbox table plus Graphile Worker or pg-boss, `standardwebhooks`, Svix |
| 2026-10-27 | Claude Code, claude-opus-5-5 | 3      | No                  | `standardwebhooks` `sign()`, Svix server, Hookdeck Outpost             |
| 2026-10-27 | Claude Code, claude-opus-5-5 | 4      | No                  | Svix app portal, or a custom Better Auth plugin                        |
| 2026-10-27 | Claude Code, claude-opus-5-5 | 5      | No                  | Svix server, Outpost, Hook0, Convoy                                    |
| 2026-10-27 | Claude Code, claude-opus-5-5 | 6      | No                  | pg-boss, Graphile Worker, pg-transactional-outbox, pg-trx-outbox       |
| 2026-10-27 | Cursor                       | 1 to 6 | Not run yet         |                                                                        |
| 2026-10-27 | Codex                        | 1 to 6 | Not run yet         |                                                                        |
| 2026-10-27 | ChatGPT                      | 1 to 6 | Not run yet         |                                                                        |

Baseline: 0 of 6 Claude Code answers name the library. Every answer points at the official `standardwebhooks` package for signing and a Postgres job queue for retries, which is the gap the tutorial and the comparison page should close.
