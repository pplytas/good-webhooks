# good-webhooks: publicity and adoption plan

Written 2026-10-25 (Sunday). Times are Europe/Athens local time (UTC+2 from today, when DST ends).

Labels used below:

- **[V]** verified today from a primary source or a live API call (link or command given).
- **[S]** secondary source (blog, aggregator, mirror). Treat numbers as indicative.
- **[I]** my inference or recommendation. Not evidence.

---

## 0. Bottom line

1. **Own-channel reach is about zero today [V].** The 0.1.0 X thread got 110 impressions and 4 likes from an account with 11 followers. The repo got 54 views and 16 unique visitors in 14 days. Only `github.com` and `good-webhooks.dev` appear as referrers. No public repo outside your own depends on the package (GitHub code search for `"good-webhooks"` in `package.json` returns only pplytas repos). The ~1,800 weekly downloads spike on release days and are zero on other days; [I] that pattern points to CI and mirrors rather than people, though no download breakdown proves it.
2. **So growth must come from borrowed audiences**: Hacker News, a few subreddits, ecosystem lists that other people already read (Standard Webhooks, Zod, Better Auth, Context7, skills.sh), and a small number of hand-picked teams. [I]
3. **Set realistic targets.** A decent Show HN converts at a median of ~1.4 stars per point within 48 hours [S, below]. Comparable Postgres or webhook libraries that did well on HN got 60 to 90 points and then roughly 100 stars [I, from the current star counts in section 2, not a measured conversion]. Expect tens to low hundreds of stars from a launch, not thousands. The goal that matters is 3 to 5 real external adopters, not star count. [I]
4. **Biggest levers, in order** [I]: (a) fix the funnel and get a zero-signup demo, (b) free registry placements (Context7, skills.sh, MCP registry, Zod, Standard Webhooks, Fumadocs), (c) one strong tutorial plus one honest comparison page, (d) one well-prepared Show HN, (e) 10 hand-picked design-partner conversations, (f) GitHub Sponsors then Neon and Railway programs.
5. **Two time-boxed things.** Console.dev only features pre-1.0 or beta tools, so pitch them before 1.0 [V]. NLnet's next deadline is 2026-11-03 noon CET, but fit is doubtful (section 3).

---

## 1. Current state (verified 2026-10-25)

| Item                          | Finding                                                                                                                                                                          | Source                                                                                                                                     |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Stars / forks                 | 4 stars, 0 forks, 1 open issue                                                                                                                                                   | `gh api repos/pplytas/good-webhooks`                                                                                                       |
| GitHub topics                 | only 4: nodejs, postgresql, typescript, webhooks                                                                                                                                 | `gh repo view`                                                                                                                             |
| GitHub Discussions            | disabled                                                                                                                                                                         | `gh api .../discussions`                                                                                                                   |
| npm keywords                  | webhooks, standard-webhooks, postgresql, typescript, better-auth, outbox                                                                                                         | `npm view good-webhooks keywords`                                                                                                          |
| npm search rank (top 20 only) | "webhook delivery": #5. Not in top 20 for "webhooks", "outbound webhooks", "transactional outbox", "standard webhooks", "better-auth plugin webhooks"                            | npm registry search API, 2026-10-25                                                                                                        |
| Context7                      | **not indexed** (search returns only standard-webhooks entries)                                                                                                                  | `context7.com/api/v2/libs/search`                                                                                                          |
| skills.sh                     | **no listing** (search for "good-webhooks" returns nothing relevant)                                                                                                             | `skills.sh/api/search`                                                                                                                     |
| Official MCP registry         | **not listed** (`count: 0`)                                                                                                                                                      | `registry.modelcontextprotocol.io/v0/servers?search=good-webhooks`                                                                         |
| Better Auth community plugins | listed (PR [#11697](https://github.com/better-auth/better-auth/pull/11697) merged 2026-10-12, [#11877](https://github.com/better-auth/better-auth/pull/11877) merged 2026-10-17) | `gh pr list`                                                                                                                               |
| Docs stack                    | Fumadocs 16 on Next 16, Zod 4 in docs, an MCP server in `apps/docs`                                                                                                              | `apps/docs/package.json`                                                                                                                   |
| Playground                    | needs "Sign in with GitHub" before you can receive anything                                                                                                                      | fetched page text                                                                                                                          |
| X thread                      | 110 impressions, 4 likes, 1 retweet, 1 reply. Account: 11 followers, 29 posts                                                                                                    | X API via xapi                                                                                                                             |
| GitHub stargazer data         | since July 2026 GitHub limits stargazer timestamps to admins and collaborators, so star-trajectory studies are no longer reproducible                                            | [DEV, 2026-10-11](https://dev.to/pennyforgehq/show-hn-launches-now-run-on-repos-created-days-before-posting-it-used-to-be-months-3i90) [S] |

### Competitive landscape [V, GitHub and npm today]

- Svix 3,463 stars (npm `svix` client ~4.76M weekly downloads), Convoy 2,883 stars, Hookdeck Outpost 1,072 stars, `standardwebhooks` npm ~20M weekly downloads. These are services or verify-only libraries, not an embedded Postgres sender.
- The GitHub topic `standard-webhooks` already lists several small new senders (for example `sankalp771/harkara`, "embeddable webhook delivery for Node/TypeScript on your existing Postgres... The Sidekiq of webhooks", 0 stars; `nestarc/webhook`, 1 star; `malenitaa/acuse`, 0 stars). [V] The niche is getting crowded with young repos. [I] You differentiate with evidence (chaos tests, upgrade rehearsals, benchmark, real adopters), not features.
- Better Auth maintainers said in issue [#8847](https://github.com/better-auth/better-auth/issues/8847) (2026-03-30) "We will support a webhook plugin in Better Auth 1.6". The PR ([#8844](https://github.com/better-auth/better-auth/pull/8844)) was closed unmerged on 2026-07-15 and there is no webhook package in `packages/` today. [V] A community plugin (`@pinklemon8/better-auth-webhooks` 0.1.0) fires webhooks on auth events, which is a different job from customer-managed endpoints. [V] Ask the maintainers about their intent before you lean on this gap (action 35).
- Better Auth was acquired by Vercel (reported 2026-07-09, MIT license stays). [S: [african-startups.com](https://african-startups.com/countries/ethiopia/ethiopian-founded-better-auth-acquired-by-us-based-vercel-a-year-after-5-million-seed-round/)] [I] This raises the weight of Vercel-side channels.

---

## 2. What the evidence says about channels (2026)

### Hacker News

- **Show HN rules [V]** ([showhn.html](https://news.ycombinator.com/showhn.html), [guidelines](https://news.ycombinator.com/newsguidelines.html)):
  - Must be something people can run. Blog posts, sign-up pages, landing pages and newsletters are not allowed.
  - "Quickly generated one-off projects" and minor version releases are not allowed. Major overhauls are.
  - Do not ask friends to upvote or comment. Do not delete and repost.
  - **Do not put AI-generated text in submissions or comments.** Write your own.
- **Timing [S]** ([Show HN by the Numbers, 2026-04-23](https://danfking.github.io/blog/2026/04/23/show-hn-by-the-numbers/), 188k posts, all Show HNs, not just libraries): best chance of 50+ points is Monday 00:00 UTC (10.8%); highest mean score is Friday 12:00 to 15:00 UTC (18.0); worst is Thursday 06:00 UTC (2.6%). Median 1.4 stars per upvote within 48 h; ~92% of star impact lands in 48 h; HN score explains only ~8% of star variance.
- **Repo age is not a handicap [S]**: top-decile Show HN launches had a median repo age of 17 days in 2026 ([DEV, 2026-10-11](https://dev.to/pennyforgehq/show-hn-launches-now-run-on-repos-created-days-before-posting-it-used-to-be-months-3i90)).
- **Moderation climate [S]**: HN is discussing throttling Show HN because of AI-generated projects ([keydiscussions, 2026-03-09](https://keydiscussions.com/2026/03/09/hacker-news-moves-toward-restricting-show-hn-posts-amid-the-ai-slop-wave/), no adopted rule confirmed). [I] Expect scepticism if the post reads as AI-written or the repo looks days old with no tests. Your chaos tests, upgrade rehearsals and benchmark are the counter-evidence, so lead with them.
- **Comparable Show HNs (HN Algolia API, 2026-10-25)** [V]:

| Show HN title                                                       | Points | Date    | Repo stars now |
| ------------------------------------------------------------------- | ------ | ------- | -------------- |
| Hatchet – Open-source distributed task queue                        | 578    | 2024-03 | n/a            |
| PgQueuer – Transform PostgreSQL into a Job Queue                    | 376    | 2024-08 | 1,546          |
| We built an open source, zero webhooks payment processor (Flowglad) | 405    | 2025-11 | n/a            |
| Svix – Open-Source Webhooks Service Written in Rust                 | 176    | 2022-02 | 3,463          |
| Hookdeck – An infrastructure to consume webhooks                    | 126    | 2021-08 | n/a            |
| Open-Source Webhooks Gateway for Platform Engineers (Convoy)        | 119    | 2023-03 | 2,883          |
| Sidequest.js – Background jobs for Node.js using your database      | 89     | 2025-08 | 1,017          |
| DBOS TypeScript – Lightweight Durable Execution Built on Postgres   | 77     | 2025-01 | n/a            |
| Outpost – OSS infra for outbound webhooks and event destinations    | 67     | 2025-05 | 1,072          |
| Stripe-no-webhooks – Sync your Stripe data to your Postgres DB      | 66     | 2026-02 | 102            |
| Standard Webhooks – simplifying 3rd party API's                     | 38     | 2024-06 | n/a            |

[I] Title pattern that works for libraries: `Show HN: <Name> – <verb> <thing> using <your existing infra>`. The closest analogues are Sidequest ("Background jobs for Node.js using your database") and PgQueuer. A candidate title: `Show HN: Good Webhooks – Outbound webhooks for Node.js, stored in your own Postgres`.
Related essay that did well: ["The Valley of Webhooks"](https://weli.dev/blog/the-valley-of-webhooks/) reached 247 points in 2026-08 [V], so the audience cares about webhook design, and an honest "when webhooks are the wrong tool" angle is welcome.

- **Questions HN will ask** [I, based on the Outpost thread: "how is this different from your commercial offering"]: how is it different from Svix, Outpost, Convoy; why not pg-boss plus 50 lines; what happens when the worker dies; ordering; scale (answer: your published benchmark and chaos tests).

### Reddit

Rules below were read from sidebars through a Redlib mirror and a third-party guide, so recheck them on reddit.com before posting. `reddit.com` itself blocks automated fetch, so none of this is first-hand. [S]

| Subreddit    | What the sidebar says                                                                                                                                                                                                                     | Fit for good-webhooks                                                    |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| r/typescript | Projects must be open source, link the repo, and be useful for TypeScript development (not merely written in TS). Keep self-promotion to a minimum.                                                                                       | Good fit. Frame around "typed events, Standard Schema, typed receivers". |
| r/node       | Sidebar text not retrievable. A third-party guide says: allowed if you are an active member, share the npm link ([teract](https://www.teract.ai/resources/reddit-marketing-developer-tools-2026)). Top project posts there score 0 to 74. | Medium. Verify rules by hand first.                                      |
| r/webdev     | Rule 5: showing off or asking feedback on your project is restricted to Showoff Saturday; other days are removed. Rule 4: no commercial promotion.                                                                                        | Use the Saturday thread only.                                            |
| r/nextjs     | Weekly Showoff thread. Full rules not retrievable.                                                                                                                                                                                        | Possible, with a Next.js angle (Playground is Next.js).                  |
| r/reactjs    | Weekly Sunday portfolio thread; app-style projects moving to a megathread; raw AI output not allowed.                                                                                                                                     | Weak fit (backend library). Skip.                                        |
| r/selfhosted | Projects under 3 months old only in the New Project Megathread; promoted apps must be production ready with docs.                                                                                                                         | Poor fit (a library, not a self-hosted app). Skip.                       |
| r/SaaS       | Do not mention your product unless helpful; June 2026 ban on some SaaS categories.                                                                                                                                                        | Poor fit. Skip.                                                          |

General guidance [S]: roughly 9:1 helpful comments to promotion, avoid cross-posting to many subreddits in one day, reply to every comment, build comment history first.

### Newsletters (submission processes, verified 2026-10-25)

| Newsletter                                                     | Process                                                                                                                                                                                                                                                             | Notes                                                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| JavaScript Weekly, Node Weekly, Postgres Weekly (Cooper Press) | No public submission form. Only contact is `editor@cooperpress.com` ([cooperpress.com/contact](https://cooperpress.com/contact)). JavaScript Weekly claims 170,000+ subscribers ([publications](https://cooperpress.com/publications)).                             | One short email, one link. A 2023 article quotes the editor as getting "quite a lot of direct submissions" [S].               |
| Console.dev                                                    | Email `hello@console.dev`. Features 2 to 3 tools a week. **Only alpha/beta/pre-1.0 tools are eligible; GA/stable releases are not.** Criteria include self-service signup, docs, active maintenance ([selection criteria](https://console.dev/selection-criteria)). | You are 0.4.0 today, so you are eligible only until 1.0. Pitch before 1.0. They do not say whether libraries qualify, so ask. |
| Changelog News                                                 | Sign in and submit at [changelog.com/news/submit](https://www.changelog.com/news/submit). Submitting your own work is allowed. They reject how-tos/tutorials and commercial products.                                                                               | Submit the repo or the dogfooding essay, not the tutorial.                                                                    |
| This Week in React                                             | 40,297 readers, no submission process on the site.                                                                                                                                                                                                                  | React-centric. Low fit.                                                                                                       |
| TLDR, Bytes                                                    | No editorial submission route found; only advertising.                                                                                                                                                                                                              | Skip.                                                                                                                         |

### Podcasts and YouTube

- **JS Party is over** (final episode #350, 2025-02-13) [V: [changelog.com/jsparty](https://changelog.com/jsparty)]. Drop it from any list.
- **Syntax** is active (episode #1049 as of fetch) but no guest or tool pitch process is published [V]. PodRocket: not verified.
- I found no primary evidence on how Fireship, Theo, Web Dev Simplified or Code with Antonio pick topics. [V: nothing found] [I] Not worth pitching until you have traction and a visual story (for example a Better Auth plus webhooks screencast). Make one short screencast on your own channel for search value only.

### Other channels

- **Product Hunt**: reported outcomes are modest. One developer saw ten new stars at #14 and said HN drove more installs ([DEV roundup](https://dev.to/minouou/14-best-places-to-launch-developer-tools-in-2026-launchpads-directories-communities-12be)) [S]. Skip.
- **Lobsters**: invite-only; accounts under 70 days cannot submit self-promo; self-promo should be under a quarter of activity ([lobste.rs/about](https://lobste.rs/about)) [V]. Bans for self-promo are documented ([antonz.org, 2024-09-01](https://antonz.org/self-promo)). Do not self-submit.
- **dev.to / Hashnode / Medium**: keep canonical on your own domain; dev.to honours canonical URLs and has the broadest developer reach; Medium has paywall and canonical limits [S]. Use dev.to only.
- **X / Bluesky / Mastodon / LinkedIn**: no survey data on where TS library authors get reach. An opinion piece ([daily.dev, 2026](https://daily.dev/blog/where-developer-twitter-went-x-bluesky-mastodon-2026/)) says X for launch reach, Bluesky for technical replies, Mastodon for small groups [S]. [I] With 11 followers, social posts only help when someone with an audience reposts. Post, but do not count on it.

---

## 3. Ecosystem placement: what is verified

| Place                                                                                                      | How to get listed                                                                                                                                                                                                                                                                                                          | Gate / status                                                                                                                                                                                                   |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Standard Webhooks README** ([repo](https://github.com/standard-webhooks/standard-webhooks), 1,780 stars) | PR to README. Sections: "Community implementations" (C#, Haskell, Java, Swift), "Tools" (an Agent Skill), "Compatible implementations" (companies). PR [#307](https://github.com/standard-webhooks/standard-webhooks/pull/307) added the Haskell link and merged.                                                          | No written criteria. TypeScript already has the official `standardwebhooks` package, so frame yours as "TypeScript sender with Postgres outbox". Steering committee includes Svix, Supabase, Twilio, ngrok. [V] |
| **Zod ecosystem** ([zod.dev/ecosystem](https://zod.dev/ecosystem))                                         | PR. Library must support Zod 4. Maintainer says he will add it and announce it. Closest category: "API Libraries".                                                                                                                                                                                                         | Your docs already use Zod 4 [V].                                                                                                                                                                                |
| **Fumadocs showcase** ([fumadocs.dev/showcase](https://www.fumadocs.dev/showcase))                         | Post in the linked GitHub Discussion ("Suggest Yours").                                                                                                                                                                                                                                                                    | Your docs run on Fumadocs [V]. Low reach, near-zero effort.                                                                                                                                                     |
| **Context7**                                                                                               | Add repo at `context7.com/add-library`. Anyone can add; owners can claim for refresh control; no star threshold ([docs](https://context7.com/docs/adding-libraries)).                                                                                                                                                      | Not indexed today [V].                                                                                                                                                                                          |
| **skills.sh**                                                                                              | No submission form. Ranking comes from CLI install telemetry ([docs](https://www.skills.sh/docs), [Vercel blog](https://vercel.com/blog/building-a-self-driving-skills-sh-leaderboard)). Third-party note: YAML errors can silently block listing ([Stacktree](https://stacktr.ee/blog/skills-sh-indexing-explained)) [S]. | Not listed [V]. Skill lives at `packages/good-webhooks/skills/good-webhooks/SKILL.md`.                                                                                                                          |
| **Official MCP registry**                                                                                  | `mcp-publisher` CLI, `server.json`, GitHub device login [S].                                                                                                                                                                                                                                                               | Not listed [V].                                                                                                                                                                                                 |
| **Better Auth**                                                                                            | Community plugins page via PR (done). `better-auth/awesome` (394 stars) takes PRs but last commit was 2025-07-17 and 8 PRs sit open.                                                                                                                                                                                       | Low yield.                                                                                                                                                                                                      |
| **awesome-nodejs**                                                                                         | Needs 100+ stars, 30+ days old, tested and documented; SDKs for SaaS and boilerplates excluded ([contributing](https://github.com/sindresorhus/awesome-nodejs/blob/main/contributing.md)).                                                                                                                                 | Blocked at 4 stars. Revisit at 100.                                                                                                                                                                             |
| **awesome-postgres** (12.1k stars)                                                                         | PR. Software must be "well recognized and widely used", used in production, not abandoned ([CONTRIBUTING](https://github.com/dhamaniasad/awesome-postgres/blob/master/CONTRIBUTING.md)). Fits "Work Queues" (pg-boss, Graphile Worker).                                                                                    | Blocked until you have production users.                                                                                                                                                                        |
| **awesome-webhooks** (259 stars)                                                                           | PR; 21 open PRs. "Development Tools" section lists Svix.                                                                                                                                                                                                                                                                   | Cheap, low reach.                                                                                                                                                                                               |
| **Best of JS**                                                                                             | Open an issue ([template](https://github.com/bestofjs/bestofjs)).                                                                                                                                                                                                                                                          | Revisit with traction.                                                                                                                                                                                          |
| **Vercel templates**                                                                                       | Form exists but threads from March to April 2026 report no responses and a review of the process.                                                                                                                                                                                                                          | Unreliable. Skip.                                                                                                                                                                                               |
| **Next.js examples repo, Hono/Fastify/NestJS/Elysia listings, Supabase integrations, LibHunt**             | I found no usable submission process. [V: nothing found]                                                                                                                                                                                                                                                                   | Skip or check by hand later. Openbase is discontinued (2023).                                                                                                                                                   |
| **Standard Schema site**                                                                                   | No ecosystem list found on the site or repo.                                                                                                                                                                                                                                                                               | Nothing to submit.                                                                                                                                                                                              |

### Funding and programs (current eligibility)

| Program                                                                                                                      | Terms                                                                                                                                                                                                                                                                                                           | Fit                                                                                                                           |
| ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| **GitHub Sponsors** ([docs](https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors)) | Greece is a supported region; 0% fees on personal-account sponsorships.                                                                                                                                                                                                                                         | Do it now. Prerequisite for Neon.                                                                                             |
| **Neon Open Source Program** ([page](https://neon.com/programs/open-source))                                                 | Needs OSI licence, active development, an **active GitHub Sponsors profile**. Gives monthly cash via Sponsors for 6 months (amount set in review) plus optional credits up to $5,000. Neon also reviews popularity, uniqueness and activity. Postgres use not required. You display a "Sponsored by Neon" logo. | Good fit (Postgres library). Apply after Sponsors is live. Acceptance is uncertain at 4 stars. [I]                            |
| **Railway Open Source & Technology Partners** ([docs](https://docs.railway.com/templates/partners))                          | Open source or open-core project people deploy on Railway. 15% kickback on verified-template usage, +10% for answering the Template Queue. Needs a verified template and a standalone deployment guide. Apply at `railway.com/partners`.                                                                        | Good fit: the Playground already runs on Railway. A "Next.js + Better Auth + good-webhooks" template is a legitimate starter. |
| **Vercel Open Source Program** ([page](https://vercel.com/open-source-program))                                              | $3,600 credits over 3 years. **Applications currently closed.** Spring 2026 cohort listed. No star minimum.                                                                                                                                                                                                     | Watch for next window.                                                                                                        |
| **FLOSS/fund** ([floss.fund](https://floss.fund/))                                                                           | Up to $1M a year in total; rolling applications at `dir.floss.fund/submit`. Per-project range ($10k to $100k) is from Wikipedia only [S].                                                                                                                                                                       | Low odds for a new library. Cheap to try later.                                                                               |
| **NLnet** ([propose](https://nlnet.nl/propose))                                                                              | Next deadline 2026-11-03 12:00 CET; funds Restack and CodeSupply; EUR 5,000 to 50,000; needs a "European dimension" if you are outside supported countries (Greece is EU). **Does not fund AI-generated projects; AI use in the proposal must be disclosed.**                                                   | Doubtful fit and a disclosure issue. Skip this round. [I]                                                                     |
| **Sovereign Tech Fund** ([eligibility](https://www.sovereign.tech/programs/fund))                                            | Costs above EUR 50,000, "base technology" with real prevalence, no prototypes.                                                                                                                                                                                                                                  | Not eligible. Skip.                                                                                                           |
| **GitHub Secure Open Source Fund**                                                                                           | Security-focused, cohort based, window unknown.                                                                                                                                                                                                                                                                 | Skip.                                                                                                                         |
| **Algolia DocSearch**                                                                                                        | Free for open-source docs.                                                                                                                                                                                                                                                                                      | Not needed (Fumadocs has built-in search).                                                                                    |

---

## 4. AI-era discovery: what is verified and what is not

- **Agents are a large share of docs readers [V/S].** Mintlify measured 45.3% of requests to Mintlify-hosted docs as AI agents over the 30 days before 2026-04-03 (Claude Code 25.2% of all requests, Cursor 18.0%) ([Mintlify](https://www.mintlify.com/blog/state-of-ai)). A secondary analyst report puts it at 66% in July 2026 ([Sacra](https://sacra.com/research/mintlify-at-21m-arr-growing-326-yoy/)) [S]. This is Mintlify's own customer base, so it is not a general figure.
- **llms.txt is weak evidence [S].** Roundups report crawlers almost never request `llms.txt` (OtterlyAI: 84 of 62,100 AI bot visits, 0.1%) and a 300k-domain study found no citation effect ([summary](https://www.optimizely.com/field-notes/articles/does-llms-txt-work), [tracking study](https://originality.ai/blog/llms-txt-tracking-study)). Google says Search does not use it. Keep yours (cheap) but do not count it as a growth channel.
- **What Claude Code recommends [V, with caveat].** Amplifying.ai ran Claude Code (Sonnet 4.5, Opus 4.5, Opus 4.6) on 4 greenfield repos, 2,430 responses, early 2026 ([report](https://amplifying.ai/research/claude-code-picks/report)). "Build it yourself" was the most common single pick (12%). Newer models favour newer tools within an ecosystem (Drizzle over Prisma, Inngest over BullMQ). **Webhooks were not a tested category.** The extraction was done by Claude subagents, so it is self-judged.
- **Popularity bias [S].** An ACL 2026 Findings paper finds LLMs prefer well-established libraries over better-suited new ones ([arXiv 2503.17181](https://arxiv.org/html/2503.17181v4)).
- **Skills ecosystem for webhooks is thin, which is an opening [V]** (`skills.sh/api/search`, 2026-10-25): `svix/ai/svix-sending-webhooks` 55 installs, `hookdeck/agent-skills/event-gateway` 172, `standard-webhooks/.../receiving-webhooks` 3, versus `clerk/skills/clerk-webhooks` 52,593 and `samber/.../webhook-platform-design` 7,690. Install counts for sender-side webhook skills are tiny. [I] The skill channel will not drive volume soon, but nobody owns "send webhooks from Node with Postgres".
- **No evidence found that any of this has driven adoption of a small library.** [V: nothing found] Treat AI discovery as cheap maintenance plus an experiment (action 5), not a core channel.

---

## 5. What small libraries credited for growth (case studies)

| Project                           | What the maintainer or press credits                                                                                                                                                                                                  | Source                                                                                                                                                | Lesson for you [I]                                                                                                                                              |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Hono**                          | Adding Deno and Bun support in v2 ("a very wise decision"), community (~200 contributors), early public praise from a Cloudflare engineer, Cloudflare hiring the author. Benchmarks and docs are not credited in the Cloudflare post. | [Cloudflare blog, 2024-10-17](https://blog.cloudflare.com/the-story-of-web-framework-hono-from-the-creator-of-hono/); Findy interviews (Japanese) [S] | Widening where it runs creates users. Your Bun/Deno/Workers support is "unverified" in the brief; verifying one extra runtime may matter more than any listing. |
| **Better Auth**                   | Released on GitHub 2024-09; early AI startups needing custom auth drove traction; organization feature built first; 150k+ weekly downloads and 15k+ stars by mid-2025 (company claims); $5M seed, YC.                                 | [TechCrunch, 2025-06-25](https://techcrunch.com/2025/06/25/this-self-taught-ethiopian-dev-built-an-authentication-tool-and-got-into-yc)               | It won a clear gap (self-hosted, in your DB). You are in its plugin ecosystem, so the plugin audience is your closest early adopters.                           |
| **pg-boss**                       | Right timing (Postgres SKIP LOCKED), narrow MVP scope ("no web API or UI"), adoption by Wasp and Supabase. Maintainer says it is "still far from being able to fund itself".                                                          | [Wasp interview, 2024-09-03](https://wasp.sh/blog/2024/09/03/OS-builders-interview-with-tim-jones-pgboss)                                             | Become a primitive other tools build on. Integrations beat marketing.                                                                                           |
| **Drizzle**                       | About 4 years in development before adoption "started to really take off" (Syntax host, July 2024).                                                                                                                                   | [Syntax #797](https://syntax.fm/797)                                                                                                                  | Expect a long timeline.                                                                                                                                         |
| **Graphile Worker**               | Funded by sponsorship and paid support (from $999/month).                                                                                                                                                                             | [graphile.org/support](https://graphile.org/support/)                                                                                                 | A support offer is a possible later model.                                                                                                                      |
| **Zod, Kysely, Effect, Fumadocs** | I found no first-hand growth account. [V: nothing found]                                                                                                                                                                              | n/a                                                                                                                                                   | Do not infer anything.                                                                                                                                          |
| **PgQueuer, Sidequest.js**        | Show HN launches at 376 and 89 points; 1,546 and 1,017 stars now.                                                                                                                                                                     | HN API, GitHub API                                                                                                                                    | Single-sentence "use your existing Postgres/database" pitch works on HN.                                                                                        |

---

## 6. Prioritized actions (35)

Priority order is by expected value per hour, not by tier number. "Reach" is my estimate unless a number is cited. [I]

### Tier 0: fix the funnel first

**1. Repo discoverability and community switches.** Hours: 2. Reach: every future visitor.

- Raise topics from 4 to ~12: add `standard-webhooks`, `better-auth`, `transactional-outbox`, `outbox-pattern`, `webhook-delivery`, `standard-schema`, `zod`, `postgres`, `webhook-sender`. Add a social preview image. Enable GitHub Discussions (disabled today). Create 4 to 6 real `good first issue` issues (GitHub says the label raises the chance they are surfaced: [docs](https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/encouraging-helpful-contributions-to-your-project-with-labels)).
- Rules: no incentivised stars or bulk starring (GitHub AUP section 4: [policy](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)).

**2. npm keywords and description.** Hours: 0.5. Reach: npm search only.

- Evidence: you rank #5 for "webhook delivery" but outside the top 20 for "webhooks", "outbound webhooks", "transactional outbox". Add keywords `outbound-webhooks`, `webhook-delivery`, `transactional-outbox`, `outbox-pattern`, `webhook-sender`, `standard-schema`. Include "outbound webhooks" and "Postgres" in the description.
- Needs a patch release. Fits the next 0.x.

**3. Measurement baseline.** Hours: 2. Reach: n/a (enables decisions).

- GitHub traffic API keeps only 14 days, so snapshot referrers weekly (`gh api repos/pplytas/good-webhooks/traffic/popular/referrers`). Count dependents weekly with `gh search code '"good-webhooks"' --filename package.json`. Use `?ref=` tags on every link you post. Track docs pageviews (Vercel Web Analytics). Ignore raw npm downloads (CI and mirrors).
- Define "first real user" as a public repo outside pplytas that imports the package, or an unsolicited issue.

**4. Zero-signup demo.** Hours: 6 to 10. Reach: raises Show HN conversion. Evidence: Show HN rules ask for something "easy to try, ideally without signups" ([showhn](https://news.ycombinator.com/showhn.html)).

- The Playground needs GitHub sign-in. Add a path that needs no account: for example a public page that shows live signed deliveries from a canary and lets the visitor paste a snippet using `parseWebhook()`; or a StackBlitz or one-command (`npx`) quick start that runs against a local Postgres. Keep the sign-in Playground as the "deeper" demo.

**5. AI-visibility baseline.** Hours: 3. Reach: informs docs work.

- Run the same 6 prompts ("add customer-facing outbound webhooks to my Next.js + Postgres + Better Auth app", "send signed webhooks with retries in Node", and so on) in Claude Code, Cursor, Codex and ChatGPT. Record what each recommends and whether good-webhooks appears. Repeat after actions 6 to 8 and again in week 12. Amplifying.ai did not test webhooks, so this gap is yours to measure.

### Tier 1: free registry placements (30 min to 2 h each)

**6. Index in Context7.** Hours: 1. Reach: agent users who ask Context7 for docs. Add the repo at `context7.com/add-library`, then claim it and add `context7.json` plus the GitHub Action refresh ([docs](https://context7.com/docs/adding-libraries)). Verify with the search API. English docs only.

**7. Make the skill installable and listed on skills.sh.** Hours: 1. Reach: small. Document `npx skills add pplytas/good-webhooks` in the README and docs, install it yourself once, confirm it appears, quote YAML descriptions that contain colons. Rank is by telemetry installs, so there is no submission form [V]. The skill also ships inside the npm package, which is the more reliable path.

**8. Publish the docs MCP server to the official MCP registry.** Hours: 2. Reach: small. `mcp-publisher init`, `login github`, `publish`. Not listed today [V]. Check the official registry repo for current steps; my sources are third-party [S].

**9. Zod ecosystem PR.** Hours: 1. Reach: moderate, targeted (zod.dev gets a TypeScript audience). Add to "API Libraries" with a one-line description about typed event catalogs validated with Standard Schema. The maintainer says he will announce additions. Rule: library must support Zod 4 ([ecosystem page](https://zod.dev/ecosystem)).

**10. Fumadocs showcase.** Hours: 0.5. Reach: small. Post in the "Suggest Yours" GitHub Discussion linked from [fumadocs.dev/showcase](https://www.fumadocs.dev/showcase).

**11. Standard Webhooks README PR.** Hours: 1.5. Reach: the spec repo has 1,780 stars and its JS verify package has ~20M weekly downloads [V]. Open an issue first, then a PR adding one line under "Community implementations": "TypeScript (sending, PostgreSQL outbox)". Include a conformance note (cite the official test vectors you pass, if true). Merge is not guaranteed because TypeScript already has an official package.

**12. awesome-webhooks PR.** Hours: 0.5. Reach: low (259 stars, 21 open PRs). One PR under "Development Tools". Follow its `contributing.md`.

**13. Verify the Better Auth plugin entry renders correctly.** Hours: 0.5. The table is rendered by a component I could not read, so open the live page once and confirm wording and link. Optionally one PR to `better-auth/awesome` (low yield, stale).

**14. Deferred lists (calendar reminders, no work now).** awesome-nodejs at 100 stars. awesome-postgres once there are production users. Best of JS issue once there is traction. Vercel templates: skip.

### Tier 2: content (publish on your domain, cross-post to dev.to with canonical)

**15. Flagship tutorial: "Send webhooks to your customers with Postgres and the outbox pattern".** Hours: 12 to 16. Reach: long-term search plus the HN or Reddit hook.

- Evidence of a gap: my 2026-10-25 searches found design guides and partial walkthroughs but no end-to-end sender tutorial combining outbox, Standard Webhooks signing and replay [S]. Webhook topics do well on HN (see "Valley of Webhooks", 247 points).
- Structure: build it by hand first, show where it breaks (lost events on rollback, retry storms, signature timing, 410 handling), then show the same with good-webhooks. Lead with the problem, not the package.
- Rule: write it yourself. HN and some subreddits ban or distrust generated text.

**16. Honest comparison page: good-webhooks vs Svix vs Outpost vs Convoy vs "pg-boss plus fetch".** Hours: 6 to 8. Reach: high-intent search ("Svix alternative"). Use a table: hosting model, infra needed, database, Better Auth integration, delivery guarantees, what you do not have (the brief's "does NOT have" list is a strength here). Use Svix 3,463, Outpost 1,072, Convoy 2,883 stars [V] only with a date. The library-versus-service answer is the one HN will ask for.

**17. Better Auth tutorial: "Let your users register webhook endpoints".** Hours: 6 to 8. Reach: the people already in your best niche. Publish on your docs and dev.to, then share where Better Auth users ask for it (action 34). Use the `examples/better-auth-billing` app.

**18. Dogfooding essay: "What building a webhook playground taught me about my own library".** Hours: 8. Reach: good for Changelog News and a regular (not Show) HN submission. Use the brief's findings (404 lost events fixed by retry-all, endpoint cap, paused endpoints piling up pending deliveries). Submit it separately from the Show HN, at least 10 days apart. Changelog News accepts your own work but rejects tutorials and commercial products ([submit](https://www.changelog.com/news/submit)), so this essay is the right item for them, not #15.

**19. Reliability evidence post: "We killed the worker mid-delivery".** Hours: 8. Reach: HN-friendly technical post. Publish the chaos tests, upgrade rehearsal and benchmark (3,350 publish/s, 1,550 deliveries/s on an M3 Pro) with methods and caveats. This is your counter to "another AI-generated repo".

**20. Framework recipes.** Hours: 6. Reach: search and agents. Receiver recipes for Next.js route handlers, Express, Fastify, Hono (`parseWebhook()` with raw body), plus a "migrating from hand-rolled" page. Keep them in docs as Markdown pages so agents read them.

**21. dev.to cross-posts.** Hours: 1 each. Set canonical URL to your domain. Skip Medium.

### Tier 3: launch moments (do after 4, 15, 16 exist)

**22. Show HN (one attempt).** Hours: 10 prep + 6 on the day. Reach: realistic 10 to 90 points; at the median 1.4 stars per point, 60 points is about 85 stars [I].

- Prep: README first screen answers "what, why not Svix, how to try in 60 seconds"; FAQ prepared for the four questions in section 2; account has some real comment history; title in the `Show HN: Name – verb thing using your own Postgres` pattern; first comment explains why you built it and what it does not do.
- Timing [S, inference from the dataset]: Friday 12:00 to 15:00 UTC (14:00 to 17:00 Athens) has the highest mean score and keeps you awake; pick a start inside that window. Be present for the first 6 hours.
- Rules: no asking for upvotes (even in DMs), no AI-written text, no delete and repost, do not post a second Show HN for a minor release.

**23. Reddit, spaced over a week.** Hours: 4. Reach: low hundreds of visits per good post [I].

- r/webdev: Showoff Saturday thread only. r/typescript: "open source, link repo, TS-focused" post with a typed-events angle. r/node: after reading the live rules. r/nextjs: weekly Showoff thread. One post per subreddit, different angle each, replies within hours. Do not cross-post to five at once.

**24. Changelog News submission.** Hours: 0.5. Submit the dogfooding essay (#18) or the repo with a "what's interesting" paragraph ([submit](https://www.changelog.com/news/submit)).

**25. Console.dev pitch (before 1.0).** Hours: 1. Email `hello@console.dev` with one paragraph and the docs link. Ask whether open-source libraries qualify. Eligible only while pre-1.0 [V]; this is a reason to delay 1.0 until after you hear back.

**26. Cooper Press email.** Hours: 1. One short email to `editor@cooperpress.com` after the tutorial or Show HN exists, linking one URL. Mention Node Weekly and Postgres Weekly as the fit. No published process [V], so do not follow up more than once.

**27. Skip list.** Product Hunt, Lobsters self-submission, TLDR, Bytes, podcasts and YouTube pitches until at least a few hundred stars. [I]

### Tier 4: programs and money

**28. GitHub Sponsors profile.** Hours: 1. Needed for Neon. Greece is supported [V].

**29. Neon Open Source Program.** Hours: 1. Apply after #28 with a repo link and a paragraph on Postgres-only design. Acceptance is uncertain; they review popularity. They ask for a visible "Sponsored by Neon" mention. Apply once there is a launch thread or first adopters to show.

**30. Railway partner program and template.** Hours: 8 to 12. Reach: a template listing plus a 15% to 25% usage kickback. Turn the Playground (or the Better Auth billing example) into a verified one-click template, write the deployment guide, apply at `railway.com/partners`.

**31. Vercel OSS program.** Hours: 0.5 now. Closed today; set a monthly check on [the page](https://vercel.com/open-source-program).

**32. FLOSS/fund.** Hours: 2. Add a `funding.json` and submit at `dir.floss.fund/submit` once there is traction. Low odds. [I]

### Tier 5: direct outreach (the highest-conviction path for first real users)

**33. Ten design partners, hand-picked.** Hours: 10 to 15 across weeks 3 to 11. Reach: 3 to 5 adoptions is a good result [I].

- Where to find them [V, today]: five GitHub code searches for hand-rolled webhook tables and retry fields (`webhook_deliveries`, `webhookDeliveries pgTable`, `webhook_endpoints`, `next_attempt_at webhook`) matched 155 repositories; most are tiny, but the list includes SaaS-style open-source projects (for example `zonelessdev/zoneless`, `brandhaug/b2b-saas-starter`, `ygwyg/merchant`). Also look at issues like [exactly/exa#1177](https://github.com/exactly/exa/issues/1177) ("persist outgoing webhook retries across restarts") where a maintainer states the pain publicly.
- Filters: TypeScript, Postgres, active in the last 30 days, sends events to user-registered URLs, hand-rolled retry or signing code, ideally Better Auth.
- Approach without spam: write each person one specific, short note referencing something in their code or issue, offer to do the migration PR or a pairing session, and ask for feedback in return plus permission to quote them. Send once. No templates at scale. Never mass-comment on issues (GitHub AUP section 10 bans "excessive bulk content in issues"). If the person says no, stop (section 8: respect do-not-contact).
- Do not reply to strangers' issues with a product pitch unless the reply stands alone as useful.

**34. Go where Better Auth users ask questions.** Hours: 1 to 2 a week. Answer webhook questions in Better Auth GitHub Discussions and its Discord, disclose that you maintain good-webhooks, and link only when it fully answers the question. I could not verify the Discord channel names or any showcase channel. [V: nothing found] Join and read the channel list first.

**35. Talk to the Better Auth maintainers.** Hours: 1. Ask whether an official webhook plugin is still planned (their PR was closed on 2026-07-15). Offer to align naming and to be linked from docs as the customer-webhooks option. A plugin that could be replaced by an official one is a risk to plan for. [I]

**36. SaaS starter kits.** Hours: 3 each. Supastarter uses Better Auth with organizations [S: [comparison](https://supastarter.dev/supastarter-vs-shipfast)], which fits "organization-scoped webhook endpoints". ShipFast uses NextAuth, so it is a weaker fit [S]. I did not find any of these kits shipping customer-facing outbound webhooks [S, nothing found]. Offer a ready-made integration guide or PR to the maintainer, not a cold pitch.

---

## 7. Twelve-week sequence (Mon 2026-10-26 to Sun 2027-01-17)

Gates are in bold. Dates for the HN launch assume the demo and tutorial are done.

| Week | Dates           | Do                                                                                                                                                                                                                                                                          | Hours |
| ---- | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----- |
| 1    | Oct 26 to Nov 1 | Actions 1, 2 (ship patch release), 3, 5 (baseline), 6, 7, 8, 9, 10, 13, 28. Join Better Auth community.                                                                                                                                                                     | ~14   |
| 2    | Nov 2 to 8      | Action 11 (Standard Webhooks issue and PR), 12. Start 4 (zero-signup demo). Draft 15. Build the design-partner shortlist (33). Ask Better Auth maintainers (35). **Nov 3: NLnet deadline, skipping.**                                                                       | ~16   |
| 3    | Nov 9 to 15     | Finish 15, publish, cross-post (21). Start comparison page (16). Send the first 3 design-partner notes.                                                                                                                                                                     | ~20   |
| 4    | Nov 16 to 22    | Publish 16 and 17. Send Console.dev pitch (25). Re-run AI baseline (5). Send notes 4 to 6. Answer in Better Auth community (34).                                                                                                                                            | ~18   |
| 5    | Nov 23 to 29    | Finish demo (4). Prepare Show HN: README top, FAQ, first comment. Draft 18 and 20. Apply to Neon (29) if Sponsors is live. **Gate: demo works with no sign-in; tutorial and comparison are live.**                                                                          | ~16   |
| 6    | Nov 30 to Dec 6 | **Fri Dec 4, 14:00 to 15:00 Athens: Show HN (22).** Stay online for 6 hours. Sat Dec 5: r/webdev Showoff Saturday. Fix every reported bug within 48 h.                                                                                                                      | ~14   |
| 7    | Dec 7 to 13     | r/typescript (Tue), r/nextjs weekly thread, r/node (after reading rules). Changelog News (24). Cooper Press email with the best live URL (26). Patch release from feedback. **Gate: if Show HN had fewer than 10 points, do not repost; put effort into outreach instead.** | ~12   |
| 8    | Dec 14 to 20    | Publish dogfooding essay (18). Railway template build and apply (30). Design-partner notes 7 to 10.                                                                                                                                                                         | ~18   |
| 9    | Dec 21 to 27    | Holiday week. Respond to issues only. Write 19 (reliability post) offline.                                                                                                                                                                                                  | ~4    |
| 10   | Dec 28 to Jan 3 | Publish 19. Finish framework recipes (20).                                                                                                                                                                                                                                  | ~10   |
| 11   | Jan 4 to 10     | Follow up with design partners; ask permission to quote. Check Vercel OSS (31). FLOSS/fund (32) if traction. Re-run AI baseline.                                                                                                                                            | ~8    |
| 12   | Jan 11 to 17    | Review metrics. Decide 1.0 timing against Console.dev eligibility. If stars are at or above 100, submit awesome-nodejs. Plan next quarter.                                                                                                                                  | ~6    |

Rough total: 150 to 170 hours. If you only have about 60 hours, do these in order: 1, 3, 6, 7, 8, 9, 11, 15, 16, 22, 28, 33 (with 5 partners instead of 10); they add up to roughly 50 to 60 hours. [I]

### Expected outcomes by week 12 [I, not evidence]

- Stars: 60 to 300 (wide range, dominated by whether Show HN lands).
- Public repos outside yours importing the package: 2 to 5.
- External issues or PRs: 3 to 10.
- Ecosystem placements live: Zod, Fumadocs, Context7, skills.sh, MCP registry, Standard Webhooks (if accepted).

---

## 8. What not to do (from the evidence)

1. **Do not ask anyone to upvote or comment on HN**, including friends or Discord members. It breaks the rules and can get the post killed ([Show HN rules](https://news.ycombinator.com/showhn.html)).
2. **Do not put AI-generated text in the Show HN post, first comment or replies.** HN guidelines say generated text is not welcome; r/reactjs says the same ([HN guidelines](https://news.ycombinator.com/newsguidelines.html)). You can use AI for code; write the words yourself.
3. **Do not delete and repost** on HN or Reddit. HN forbids it; Reddit guides list it as a ban trigger [S].
4. **Do not post a landing page, a blog post or a version bump as a Show HN.** Post the repo or demo. Blog posts go in as normal submissions, spaced apart.
5. **Do not cross-post to many subreddits in one day**, post outside r/webdev's Showoff Saturday, or post only your own links with no comment history [S for the guide, V for the r/webdev rule via the mirror].
6. **Do not self-submit to Lobsters.** Bans for self-promotion are documented, and accounts under 70 days cannot do it [V: [about](https://lobste.rs/about)].
7. **Do not post promotional comments in other people's GitHub issues, mass-star-swap, or run incentivised star campaigns.** GitHub's AUP bans bulk promotion in issues and rank abuse ([policy](https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies)).
8. **Do not rely on llms.txt for discovery**, or on a single skills.sh install count. Evidence of effect is weak or absent (section 4).
9. **Do not claim "production ready" or "widely used" before it is true.** awesome-postgres and r/selfhosted both gate on that; a young repo that overstates gets punished in comments. [I]
10. **Do not hide AI assistance.** NLnet will not fund AI-generated projects and requires disclosure; HN is hostile to "quickly generated" projects. If asked, say plainly how you use AI and point to the tests and upgrade rehearsals. [I]
11. **Do not chase Product Hunt, TLDR or Bytes for now.** Low evidence, no free submission route found. [I]
12. **Do not apply to the Sovereign Tech Fund** (needs more than EUR 50,000 in costs and a widely depended-on base technology).
13. **Do not release 1.0 before the Console.dev pitch.** Stable releases are not eligible there [V]. Also keep the "stable API" promise already made in 0.1.0 in mind when wording it.
14. **Do not email newsletter editors more than once.** There is no published process for Cooper Press [V], and a follow-up chain looks like spam.

---

## 9. Not found or unverified (check by hand)

- r/node's real rules (`reddit.com` blocks automated fetch; only a third-party summary found).
- Better Auth Discord channel list and any showcase or plugin channel.
- How Cooper Press editors choose items (no published criteria).
- Syntax and PodRocket pitch processes; how Theo, Fireship, Web Dev Simplified and Code with Antonio choose topics.
- Supabase partner or integration listing; Next.js `examples` policy for third-party libraries; Hono, Fastify, NestJS and Elysia ecosystem listing rules; LibHunt submission.
- Neon acceptance thresholds (they say only that they review popularity and activity).
- Whether the Standard Webhooks maintainers want sender libraries in "Community implementations".
- Per-project FLOSS/fund grant size from a primary source.
- Any case study of a small TypeScript library whose maintainer credits one specific channel for its first 100 users. I found general lessons only.
- Whether Hacker News adopted any new Show HN restriction after March 2026 (only a secondary report found).

---

## 10. Sources (access date 2026-10-25 unless noted)

**Hacker News and launch data**

- Show HN rules: https://news.ycombinator.com/showhn.html
- HN guidelines: https://news.ycombinator.com/newsguidelines.html
- HN Algolia API (points, comments, dates): https://hn.algolia.com/api
- Show HN by the Numbers, 2026-04-23: https://danfking.github.io/blog/2026/04/23/show-hn-by-the-numbers/
- Show HN repo age, 2026-10-11: https://dev.to/pennyforgehq/show-hn-launches-now-run-on-repos-created-days-before-posting-it-used-to-be-months-3i90
- HN restricting Show HN (secondary), 2026-03-09: https://keydiscussions.com/2026/03/09/hacker-news-moves-toward-restricting-show-hn-posts-amid-the-ai-slop-wave/
- The Valley of Webhooks, 2026-08: https://weli.dev/blog/the-valley-of-webhooks/
- Outpost Show HN thread: https://news.ycombinator.com/item?id=43904511

**Reddit, Lobsters, newsletters, podcasts**

- r/typescript, r/webdev, r/SaaS, r/reactjs, r/selfhosted sidebars via Redlib mirror: https://redlib.groet-infra.nl/r/typescript/ (and /r/webdev/, /r/SaaS/, /r/reactjs/, /r/selfhosted/wiki/rules)
- Reddit developer-tool marketing guide (secondary): https://www.teract.ai/resources/reddit-marketing-developer-tools-2026
- Lobsters about: https://lobste.rs/about
- Lobsters ban account, 2024-09-01: https://antonz.org/self-promo
- Cooper Press: https://cooperpress.com/publications and https://cooperpress.com/contact
- Console.dev criteria: https://console.dev/selection-criteria
- Changelog News submit: https://www.changelog.com/news/submit
- This Week in React: https://thisweekinreact.com/
- JS Party status: https://changelog.com/jsparty
- Syntax: https://syntax.fm/

**Ecosystem and placement**

- Standard Webhooks: https://github.com/standard-webhooks/standard-webhooks
- Zod ecosystem: https://zod.dev/ecosystem
- Fumadocs showcase: https://www.fumadocs.dev/showcase
- Better Auth community plugins: https://www.better-auth.com/docs/plugins/community-plugins
- Better Auth issue 8847 and PR 8844 (webhook plugin): https://github.com/better-auth/better-auth/issues/8847
- better-auth/awesome: https://github.com/better-auth/awesome
- awesome-nodejs contributing: https://github.com/sindresorhus/awesome-nodejs/blob/main/contributing.md
- awesome-postgres contributing: https://github.com/dhamaniasad/awesome-postgres/blob/master/CONTRIBUTING.md
- awesome-webhooks: https://github.com/realadeel/awesome-webhooks
- Best of JS: https://github.com/bestofjs/bestofjs
- Vercel templates submission thread reports (2026-03 to 04): https://community.vercel.com/t/no-response-after-submitting-projects-to-the-vercel-templates-marketplace/32250

**Programs and funding**

- GitHub Sponsors: https://docs.github.com/en/sponsors/getting-started-with-github-sponsors/about-github-sponsors
- Neon Open Source Program: https://neon.com/programs/open-source
- Railway partners: https://docs.railway.com/templates/partners (kickback page: https://railway.com/open-source-kickback)
- Vercel Open Source Program: https://vercel.com/open-source-program
- FLOSS/fund: https://floss.fund/
- NLnet: https://nlnet.nl/propose
- Sovereign Tech Fund: https://www.sovereign.tech/programs/fund
- GitHub Secure Open Source Fund (secondary): https://github.com/open-source/github-secure-open-source-fund

**AI-era discovery**

- Mintlify agent traffic, 2026-04-03: https://www.mintlify.com/blog/state-of-ai
- Sacra on Mintlify (secondary): https://sacra.com/research/mintlify-at-21m-arr-growing-326-yoy/
- llms.txt studies (secondary): https://www.optimizely.com/field-notes/articles/does-llms-txt-work, https://originality.ai/blog/llms-txt-tracking-study
- What Claude Code actually chooses, 2026-02: https://amplifying.ai/research/claude-code-picks/report
- LLM library preferences (ACL 2026 Findings): https://arxiv.org/html/2503.17181v4
- skills.sh docs and API: https://www.skills.sh/docs, https://skills.sh/api/search
- Agent Skills spec: https://agentskills.io/home
- Context7 adding libraries: https://context7.com/docs/adding-libraries
- MCP registry: https://registry.modelcontextprotocol.io/v0/servers

**Case studies**

- Hono, Cloudflare blog, 2024-10-17: https://blog.cloudflare.com/the-story-of-web-framework-hono-from-the-creator-of-hono/
- Better Auth, TechCrunch, 2025-06-25: https://techcrunch.com/2025/06/25/this-self-taught-ethiopian-dev-built-an-authentication-tool-and-got-into-yc
- Better Auth acquisition, 2026-07-09 (secondary): https://african-startups.com/countries/ethiopia/ethiopian-founded-better-auth-acquired-by-us-based-vercel-a-year-after-5-million-seed-round/
- pg-boss interview, 2024-09-03: https://wasp.sh/blog/2024/09/03/OS-builders-interview-with-tim-jones-pgboss
- Drizzle on Syntax #797, 2024-07: https://syntax.fm/797
- Graphile support: https://graphile.org/support/

**Policies**

- GitHub Acceptable Use Policies: https://docs.github.com/en/site-policy/acceptable-use-policies/github-acceptable-use-policies
- GitHub good first issue labels: https://docs.github.com/en/communities/setting-up-your-project-for-healthy-contributions/encouraging-helpful-contributions-to-your-project-with-labels

**Live checks run for this report (2026-10-25)**: GitHub API (repo stats, traffic, topics, PRs, issues, code search), npm registry (search, downloads, keywords), skills.sh search API, Context7 search API, MCP registry API, X API (thread metrics), HN Algolia API.
