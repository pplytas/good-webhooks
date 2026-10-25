# Roadmap: 0.4.0 to 1.0.0

Written 2026-10-25. Dates are targets in Europe/Athens time and assume one maintainer working part time with agent help. Evidence lives in [`docs/research/2026-10-roadmap`](research/2026-10-roadmap/): what outbound-webhook builders complain about, what the alternatives ship, what comparable libraries meant by 1.0, and how small libraries find users.

## Where we are

Facts checked on 2026-10-25:

- `good-webhooks` 0.4.0, 17 days after the first release. 4 GitHub stars, 0 forks, no public repository outside `pplytas` depends on it. npm downloads happen only on release days (CI and mirrors). The docs site had about 220 visitors in two weeks, 93% direct, decaying to 5 to 7 a day; one in five visitors opens a docs page.
- The library already covers the hard parts that most of the alternatives get wrong or charge for: transactional publish, Standard Webhooks signing, a 28-hour retry schedule with jitter and `Retry-After`, automatic pauses, secret and key rotation, DNS-pinned SSRF defence with no redirects and a response-size cap, per-endpoint in-flight caps, `prune()`, `runOnce()`, versioned schema upgrades rehearsed in CI, chaos tests, and a published benchmark.
- Four other embeddable TypeScript senders appeared between May and August 2026 (CommitCourier, Postel, @xtandard/webhooks, harkara), all with 0 stars. CommitCourier already has a dead-letter list, OpenTelemetry, LISTEN/NOTIFY, and a doctor CLI. Features will not separate us; evidence and distribution will.
- Better Auth's own webhook plugin PR was closed unmerged on 2026-07-15, and the maintainers declined a core event system. The niche is open, but an official plugin could still appear.
- One behaviour gap found while writing this: a delivery older than `retry.maxAgeMs` (48 hours) fails when it is next claimed, and an automatic pause lasts five days, so every delivery queued behind an automatic pause fails on resume. The Playground's `failing` endpoint had 288 of them on 2026-10-24. 0.5.0 decides what to do.

## What 1.0 means here

Comparable libraries rarely state 1.0 criteria. Libraries that own a database schema (graphile-worker, Kysely, Drizzle) stayed at 0.x for years because they kept needing breaking changes; libraries that wanted trust fast tagged 1.0 after 4 to 17 months (Hono 4, Better Auth 7, Inngest 10, pg-boss 12, Fastify 17). A 1.0 is a promise about notice and migration, not a freeze.

For `good-webhooks`, 1.0.0 will mean:

1. The public surface and every interface a host implements are frozen for 1.x. A breaking change needs a deprecation in an earlier 1.x minor and ships only in 2.0. Additive upgrade SQL (new nullable columns, new indexes) with a rollout order may ship in a 1.x minor when the previous minor announced it; destructive schema changes wait for 2.0. Without that allowance every new column would be a major, which is what kept schema-owning libraries at 0.x for years.
2. The support matrix is published with a drop policy: Node.js and PostgreSQL lines are dropped only in a major and only after upstream end of life; Better Auth and TypeScript, which publish no end of life, are supported for the current and previous minor.
3. Behaviour is proven beyond the current benchmark: large history, many workers, and a multi-day soak with faults.
4. Security has response targets, and releases do not depend on one account.
5. At least two integrations outside the maintainer's own apps have run it and fed back, or the maintainer has decided in writing to ship 1.0 without that, as Hono and Better Auth did.

The current stability policy already states most of the contract. 1.0 turns the "before 1.0, a minor may change a default" escape clause off.

## Principles for 0.5 to 1.0

- **Every feature cites its evidence.** In order of weight: a dogfood finding or a design partner's request, a recurring complaint in the research, then a feature that two or more of Svix, Hookdeck, Convoy, and Outpost ship. A major competitor offering something is a signal that it is useful; it ranks below direct evidence only because their users are not yet ours.
- **Stay a library.** No bundled UI or portal, no payload transformations, no FIFO, no mTLS or OAuth to receivers, no second database for delivery, no hosted service. Each of these is in the research as scope creep or an enterprise-tier feature elsewhere.
- **One more schema version before 1.0** (6), shipped in 0.5.0 with upgrade SQL and a rollout order as today. It carries every column 0.5.0 and 0.6.0 need, so 0.6.0 is a pure code release.
- **Fix the host-implemented interfaces once.** `EndpointSource` broke custom implementers in 0.2.0 and `ManagementRepository` and `EndpointManagement` in 0.3.0, each time because a method or a parameter was added. 0.5.0 moves growth points to options objects and optional fields, and designs every field 0.6.0 will store, so 1.0 can freeze them.
- **One minor every 4 to 6 weeks.** The 0.1 to 0.4 pace (four minors in three days) is fine for a project nobody runs, but a slower, announced cadence is part of the 1.0 signal.
- **Announce every breaking minor in the release before it**, as 0.1.1, 0.2.1, and 0.3.0 did.

## Releases

### 0.4.x patches, now to mid-November 2026

No API change. Each item is cheap and either fixes the funnel or removes a 1.0 blocker early.

| Item                                                                                                                                                                                                                               | Why                                                                                                                                               |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| npm keywords and description: add `outbound-webhooks`, `webhook-delivery`, `transactional-outbox`, `outbox-pattern`, `webhook-sender`, `standard-schema`; say "outbound webhooks" and "PostgreSQL" in the description              | Ranked outside the top 20 for "webhooks" and "outbound webhooks" on npm search                                                                    |
| Docs: a serverless and cron page (`runOnce()` on Vercel cron, Railway cron, Lambda schedules; why Workers only publish and verify)                                                                                                 | The docs never mention serverless; the hosted alternatives all document it                                                                        |
| Docs: a Fastify receiver recipe next to Next.js, Hono, and Express (same raw-body shape as Express); NestJS when someone asks                                                                                                      | Raw-body signature failures are the highest-volume receiver complaint for Express and Stripe; Fastify and NestJS demand is inferred, not observed |
| Docs: one paragraph in delivery guarantees on handling out-of-order events (a version or timestamp per entity, idempotent handlers)                                                                                                | Ordering is a top-3 pain; "no ordering" and "process each event once" are documented, the per-entity advice is not                                |
| Docs: a threat table in the security concept page (asset, attack, defence, test), linked from `SECURITY.md`                                                                                                                        | The page already describes secrets, signing, the timestamp window, DNS pinning, and retention; 1.0 wants it in reviewable form                    |
| CI: `attw --pack` and `publint` on the tarball; TypeScript 6.0 in the matrix                                                                                                                                                       | Declared range includes 6.0 but CI checks 5.9.3 and 7.0 only                                                                                      |
| Repo: Dependabot or Renovate, CodeQL, OpenSSF Scorecard workflow, `SECURITY.md` response targets (initial response within 14 days, medium or higher fixed within 60 days), GitHub Discussions on, topics raised from 4 to about 12 | Verified gaps; each takes under an hour                                                                                                           |
| Announce 0.5.0's breaking interface changes in the 0.4.1 release notes                                                                                                                                                             | Stability policy                                                                                                                                  |

### 0.5.0, early December 2026: recover deliveries, settle the interfaces

Kept small so it fits beside the launch work. The strongest evidence in the research is receivers losing events after a bad deploy and needing to catch up in bulk.

| Change                                                   | Shape                                                                                                                                                                                                                                                                                                                                                                                                                      | Evidence                                                                                                                          |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| Bulk replay                                              | `deliveries.replayMany({ endpointId, status?, since?, until?, limit? })`: `endpointId` required, `status` defaults to `failed` (or `succeeded`), `since` and `until` filter on `createdAt`, `limit` defaults to 100 and caps at 1,000. Each delivery follows `replay()`'s rules (originals only, active endpoint, within retention, skipped when a replay is already pending). Returns `{ replayed, skipped, nextCursor }` | Pain 1 (9+ sources, Stripe's former webhooks owner among them); CommitCourier caps mass replay for safety                         |
| Failed list as a first-class view                        | Document `deliveries.list({ status: 'failed' })` plus `replayMany` as the dead-letter workflow; no new table                                                                                                                                                                                                                                                                                                               | Table stakes across queues and senders; the data already exists                                                                   |
| Deliveries queued behind a pause                         | A pause resets the delivery's retry window: `window_started_at` on each delivery, cleared when the worker defers for a paused endpoint and set when it next sees the endpoint active, so a delivery that waited out a five-day pause has its full `retry.maxAgeMs` again. [ADR 0015](adr/0015-pause-resets-delivery-window.md)                                                                                             | Dogfood log #74 (288 pending per paused endpoint); the 1.0 research names this as a decision to take before the interfaces freeze |
| Interface review (breaking for custom implementers only) | `ManagementRepository.create(scope, endpoint, { limit })` takes an options object; `StoredEndpoint` gains `encryptedHeaders: string \| null` (one encrypted JSON blob, like the secrets) with a documented "store it, never drop it" rule; the active `EndpointResolution` gains an optional `headers` field that custom sources may omit; `EndpointManagement` growth goes through optional methods                       | Implementers broke in 0.2.0 and 0.3.0; 1.0 freezes these                                                                          |
| OpenTelemetry recipe                                     | A docs page plus `examples/operations/otel.ts` mapping `onAttempt` to a histogram and counters and `onEndpointPaused` to a counter, depending only on `@opentelemetry/api`; no new entry point                                                                                                                                                                                                                             | Pain 11; Outpost and CommitCourier ship OTel; a recipe tests demand before a package                                              |

Schema moves to 6 here: `webhook_deliveries.window_started_at` and `webhook_endpoints.encrypted_headers` (unused until 0.6.0), with `getPostgresUpgrade({ from: 5 })` and `migrations/upgrades/006-*.sql`. The Better Auth plugin gains the optional `encryptedHeaders` field at the same time, so Better Auth adopters run one `auth migrate` at 0.5.0 and none at 0.6.0. The upgrade is additive, so 0.4.x processes keep working until restart.

The Playground upgrades the same day and gets a "Replay failed since" control on the endpoint page that calls `replayMany`, so the dogfood exercises the new call. Pull requests land in this order: schema 6 first, then the window reset, `replayMany`, the interface review, and the OTel recipe in parallel, then the release PR. Tracked in [#89](https://github.com/pplytas/good-webhooks/issues/89).

### 0.6.0, January 2027: endpoint owners see and operate

| Change               | Shape                                                                                                                                                                                                                                                | Evidence                                                                                                                    |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Per-endpoint headers | `headers?: Record<string, string>` on create and update, encrypted at rest like secrets, sent on every attempt and test event; a reserved-name check (no `webhook-*`, `content-type`, `user-agent`)                                                  | Pain 9: requested on Svix, Convoy, and Outpost; the cheapest feature in the matrix; needed by receivers behind API gateways |
| Delivery stats       | `deliveries.stats(scope?)`: counts by delivery status, oldest pending age, attempts and outcomes in the last hour. Endpoint counts by status and pause reason come from `endpoints.list()` on the management side, so `EndpointSource` does not grow | Dogfood finding 3 (`/status` reads tables directly); pain 11 ("alert on backlog growth, not single failures")               |
| Event catalog export | `describeEvents()` returns the event names and, when the validator supports it (Zod 4 `toJSONSchema`, Valibot, ArkType via their own converters), a JSON Schema per event, for hosts to publish a receiver-facing catalog page                       | Pain 14 (5 sources); Svix builds its portal catalog on this                                                                 |

No SQL: schema 6 from 0.5.0 already holds the `encrypted_headers` column and the Better Auth field.

Run the 72-hour soak and the large-history benchmark on 0.6.0 in early February. Any default they show to be wrong is announced in a 0.6.1 patch and changed in 0.7.0.

### 0.7.0, February to March 2027: proof at scale

No new features. This release publishes the evidence 1.0 rests on and closes the support-matrix items.

- A large-history benchmark: millions of delivery rows with `prune()` running, claim latency flat, published next to the existing profile.
- Multi-worker contention: 8 to 32 workers on one scope with an invariant checker (no lost event, no delivery stuck in flight, every attempt recorded). The chaos script already has the primitives.
- The 72-hour Playground soak with periodic worker kills, database restarts, and slow receivers, reported in the dogfood log.
- Property tests with fast-check for the retry schedule and `Retry-After` clamping, signature parsing with malformed headers, and the delivery state machine. Cross-check signing against the Standard Webhooks reference vectors.
- CI on PostgreSQL 19 (RC1 shipped 2026-10-15, GA planned for October), Node.js 26 as the primary LTS line (Active LTS from 2026-10-28), Better Auth 1.8 stable if it has shipped.
- A runtime statement: the worker is Node.js only; `parseWebhook()` is verified on Bun, Deno, and Cloudflare Workers (Web Crypto only), or the docs say which are not.
- Default changes announced in 0.6.1, if any. This is the last release where a default may change without a deprecation.

### 1.0.0-rc.1, March 2027, and 1.0.0, April to May 2027

The release candidate carries the 1.0 contract text, the upgrade matrix (which package versions may run together during a rollout), and a short 0.x to 1.0 migration guide. No code change. Hold the candidate for at least four weeks while the Playground soaks on it.

Gate for 1.0.0, all required:

- [ ] Stability policy rewritten for 1.x: public surface, breaking definition, deprecation rule, schema and rollout contract (including the additive-SQL allowance), support windows (previous major gets security fixes for six months after the next major).
- [ ] Host-implemented interfaces reviewed and frozen; an API report checked in CI so any export change is a visible diff.
- [ ] Support matrix with the drop policy published; PostgreSQL 19 and Node.js 26 verified.
- [ ] 0.7.0 proof published: large history, multi-worker contention, soak.
- [ ] `SECURITY.md` with response targets; Dependabot, CodeQL, and Scorecard running.
- [ ] Releases survive the maintainer's absence: OIDC-only releases plus a written handover and a maintenance statement in the README, or a named second person with npm org membership and GitHub admin if one fits by the release candidate.
- [ ] Two integrations outside the maintainer's apps with feedback incorporated, or a written decision to ship without them.

Planned before 1.0 but not gating it: the remaining 0.4.x docs pages, the OTel recipe, the Console.dev pitch (they feature pre-1.0 tools only, so send it in November).

## Deferred, with the evidence that would unblock each

| Candidate                                                                                                               | Status                                                                                                                                                                                                                                                                  | What would move it                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| Better Auth delivery-history and replay routes plus client methods                                                      | Every hosted sender gives endpoint owners a delivery log and resend, which argues for it; core already has `deliveries.list`, `get`, `replay`, #75 said revisit "if that proves awkward or a user asks", and the Playground calls them from server code without trouble | First candidate for 0.7.0 or 1.1; sooner if a Better Auth user needs history from the auth client or the Playground finds server-side calls awkward |
| Pull API for receivers (events since a cursor, for reconciliation)                                                      | Second-strongest pain in the research, but it needs an events-by-cursor query and a receiver authentication model the library does not own                                                                                                                              | A design partner asking for it                                                                                                                      |
| LISTEN/NOTIFY wake-up                                                                                                   | Polling costs up to one interval per delivery; CommitCourier has it; #75 lists the pooler and NOTIFY-lock costs                                                                                                                                                         | A latency report from a real deployment                                                                                                             |
| Circuit-breaker state between retrying and the 5-day pause                                                              | Convoy's maintainers found error-density rules hard to get right                                                                                                                                                                                                        | An owner report that five days is too long or too short                                                                                             |
| Per-endpoint rate limit to receivers                                                                                    | Svix, Hookdeck, Convoy, and Inngest all offer one, so the need is real; only `maxInFlight` today, and no library user has asked                                                                                                                                         | Next in line after 0.6.0 if a design partner runs a rate-limited receiver; otherwise a receiver asking for a per-second cap                         |
| Packaged OpenTelemetry entry point                                                                                      | Recipe ships in 0.5.0                                                                                                                                                                                                                                                   | Two users copying the recipe                                                                                                                        |
| Receiver-controlled "do not retry" response header                                                                      | Svix has one (`webhook-delivery: abort-message`); ADR 0013 already lets a receiver discard with a 2xx. Cheap, a few lines in the worker                                                                                                                                 | A second major sender adopting it, or a receiver that cannot answer 2xx for a message it wants dropped                                              |
| Ordered delivery per endpoint                                                                                           | Svix calls FIFO "almost always not the right solution"; Stripe does not guarantee it                                                                                                                                                                                    | Nothing before 2.0                                                                                                                                  |
| Dashboard or receiver portal, transformations, mTLS or OAuth, non-PostgreSQL delivery, CLI with tunnels, hosted service | Out of scope                                                                                                                                                                                                                                                            | Not planned                                                                                                                                         |

## Growth plan

Own-channel reach is near zero (the 0.1.0 thread on X reached 110 people from an account with 11 followers), so users have to come from audiences other people already have. The research puts the levers in this order: fix the funnel, free listings, one strong tutorial and one honest comparison, one Show HN, ten hand-picked design partners, then programs and money. Realistic outcome by mid-January 2027: tens to low hundreds of stars, and 2 to 5 outside repositories using the package. The second number is the one that matters.

The launch waits for its own gate (a zero-signup demo, the tutorial, and the comparison page), not for 0.5.0. If 0.5.0 is out by then, lead with bulk replay; if not, launch anyway.

### First two weeks (about 30 hours)

1. Repo switches: topics to about 12, Discussions on, four to six real `good first issue` items, social preview checked.
2. npm keywords and description in a 0.4.1 patch.
3. A measurement baseline: weekly snapshot of GitHub referrers (the API keeps 14 days), weekly count of public dependents, `?ref=` on every posted link, and six fixed prompts run in Claude Code, Cursor, Codex, and ChatGPT to record whether the library is recommended. Repeat the prompts after the content lands.
4. Free listings: Context7 (not indexed today), skills.sh (install the skill once and confirm it lists), the official MCP registry for the docs MCP server, the Zod ecosystem page (docs already use Zod 4), the Fumadocs showcase thread, awesome-webhooks. Open an issue on the Standard Webhooks repo before a README PR; merge is not guaranteed because TypeScript has an official verify package.
5. GitHub Sponsors profile (prerequisite for Neon's open source program).
6. Ask the Better Auth maintainers whether an official webhook plugin is still planned, and offer to align naming or be linked as the receiver-endpoints option.
7. Start commenting on Hacker News with the account that will post the Show HN. A fresh account with no history is a handicap there.

### Before the launch (November 2026)

8. A zero-signup demo. Show HN asks for something people can try without an account, and the Playground needs GitHub sign-in. Cheapest form: a public page on the Playground that shows live signed deliveries to the canary with the verifying code beside them, or an `npx` quick start against a local PostgreSQL.
9. Flagship tutorial on the docs domain, cross-posted to dev.to with a canonical link: build sending by hand, show where it breaks (rollback loses events, retry storms, signature timing, 404 during a domain move), then the same with the library. No end-to-end sender tutorial combining outbox, Standard Webhooks, and replay exists today.
10. Honest comparison page: the library against Svix, Outpost, Convoy, and "pg-boss plus fetch", with the things it does not have listed. Hacker News will ask "why not Svix" and "why not pg-boss and 50 lines"; this page is the answer.
11. Better Auth tutorial: let signed-in users register endpoints, built on the billing example.
12. Console.dev pitch by email, since they feature pre-1.0 tools only; ask whether libraries qualify.
13. First three design-partner notes (see 16).

### Launch (December 2026)

14. One Show HN, on a Friday between 14:00 and 17:00 Athens time, title in the pattern "Show HN: Good Webhooks – outbound webhooks for Node.js, stored in your own Postgres". Comparable launches (Sidequest, PgQueuer, Outpost) scored 67 to 376 points; the median conversion is about 1.4 stars per point. Rules that matter: no asking anyone to upvote, no deleting and reposting, no second Show HN for a minor release, and write the post and every reply yourself, because the guidelines reject generated text and the audience is hostile to it. Lead with the chaos tests, the upgrade rehearsal, and the benchmark. If it scores under 10 points, do not repost; move the effort to design partners.
15. The week after: r/webdev Showoff Saturday, r/typescript with the typed-events angle, r/nextjs weekly thread, r/node after reading its live rules; one subreddit per day. Changelog News with the repo. One email to Cooper Press (Node Weekly, Postgres Weekly) with the best live URL, no follow-up.

### Design partners (November 2026 to January 2027)

16. Ten hand-picked teams, one personal note each. GitHub code search for hand-rolled webhook tables (`webhook_deliveries`, `next_attempt_at`, `webhook_endpoints`) matched 155 repositories; filter for TypeScript, PostgreSQL, activity in the last 30 days, and ideally Better Auth. Offer the migration PR or a pairing session; ask for feedback and permission to quote. Send once, never bulk, never a pitch in someone else's issue. Three to five adoptions is a good result and satisfies the 1.0 gate.
17. Answer webhook questions in Better Auth Discussions and Discord, disclosing the affiliation and linking only when it fully answers the question. Offer SaaS starter kits that use Better Auth with organizations (Supastarter is the closest fit) an integration guide, not a pitch.

### After the launch (December 2026 to January 2027)

18. Dogfooding essay from the Playground log (the 404 that lost an event, the endpoint cap, deliveries that aged out behind a pause), submitted to Hacker News as a normal post at least ten days after the Show HN.
19. Reliability post: the chaos tests, the upgrade rehearsal, and the 0.7.0 numbers with methods and caveats.
20. Railway partner program: turn the Playground or the billing example into a verified one-click template (15% to 25% usage kickback). Apply to Neon's open source program once Sponsors is live and there is a launch thread to show. Vercel's program is closed; check monthly.
21. awesome-nodejs at 100 stars; awesome-postgres once there are production users.

### Not worth the time

Product Hunt, Lobsters self-submission, TLDR, Bytes, podcast and YouTube pitches before a few hundred stars, NLnet and the Sovereign Tech Fund (poor fit, and NLnet requires AI-use disclosure and declines generated projects), and counting on llms.txt (crawlers rarely request it; keep it as cheap upkeep).

## Risks

- **An official Better Auth webhook plugin** would take the main differentiator. Asking now (item 6) and being listed from their docs is the mitigation.
- **Hacker News reading the project as generated.** The repo is young and the maintainer uses agents. The counter is evidence (tests, rehearsals, benchmark) and writing the launch text by hand.
- **No outside adopter by March 2027.** Then the 1.0 gate falls to the written decision in item 5 of the contract. Ship 1.0 anyway if the technical gate is green; a long 0.x with no users signals less than a 1.0 with a clear policy.
- **Single maintainer.** Automated releases through OIDC make a handover cheap. Say in the README what happens if maintenance stops.

## Decisions settled on 2026-10-25

1. Deliveries queued behind a pause get their full retry window again on resume ([ADR 0015](adr/0015-pause-resets-delivery-window.md)).
2. 1.x minors may carry announced additive SQL; destructive schema changes wait for 2.0.
3. Release continuity before 1.0 is OIDC-only releases plus a written handover and a README maintenance statement, revisited at the release candidate.
4. 1.0 ships in April to May 2027 if the technical gate is green, with or without an outside adopter.

## Metrics

Track weekly, in the Monday watch task: public dependents, unsolicited issues and PRs, docs visitors and the share reaching `/docs`, referrers, and the six AI prompts. Ignore raw npm downloads.
