# Documentation website analytics

Implemented and verified locally on 11 October 2026. Release: [PR #20](https://github.com/pplytas/good-webhooks/pull/20).

## Accepted decisions

- Use standard Vercel Web Analytics for the Good Webhooks documentation website.
- Start without the Web Analytics Plus add-on.
- Keep the integration small while the library has almost no usage.
- Do not collect search text.

## Initial scope

Collect automatic page views on production only. Use Vercel's standard reports to see visitors, popular pages, and referrers.

The shared layout mounts the Next.js component from `@vercel/analytics` only when `VERCEL_ENV=production`. Vercel supplies the variable during production builds. Local and preview builds omit the component. Web Analytics must also be enabled for the existing Vercel project.

Defer all custom events, including copy actions, search interactions, outbound links, and AI destinations. Revisit them when there is enough traffic to answer a specific product question. Direct Markdown requests, MCP calls, and npm downloads are outside browser page-view analytics.

## Verified starting point

The Vercel project is `consola-technologies/good-webhooks`, with `apps/docs` as its root directory. The team has an active Pro plan and exposes Vercel system environment variables. Before this change, the application had no analytics integration. The Web Analytics query API returned `web_analytics_not_enabled` on 11 October 2026.

Vercel currently charges Pro teams $0.03 per 1,000 events, subject to their usage credit. See [Vercel pricing](https://vercel.com/docs/analytics/limits-and-pricing).

## Delivery and verification

The package build, docs type checks, docs build, link checks, browser smoke checks, and formatting passed. React Doctor reported 100/100. Independent source review found no actionable issues.

Browser verification of a build with `VERCEL_ENV` unset found no analytics script or initialization on initial load or navigation. A separate build with `VERCEL_ENV=production` loaded one analytics script and queued one page view on initial load and one after client navigation. No custom events were queued. The local server does not serve Vercel's analytics endpoint, so these checks verify the SDK integration, not ingestion by Vercel.

After deployment, verify that Vercel receives page views. Report implementation, deployment, and live data verification separately.

Vercel Web Analytics was enabled on 11 October 2026 before the production release. The API confirmed activation with a zero-page-view baseline. For a replacement project, the Vercel CLI requires a person to confirm enabling the paid feature in an interactive terminal:

```sh
vercel project web-analytics enable good-webhooks --scope consola-technologies
```

Enable it before the production deployment so Vercel includes its analytics routes.

This is a reversible website integration. It does not warrant an architecture decision record or changes to the outbound-webhooks glossary.

## Speed Insights

Added on 15 October 2026 using `@vercel/speed-insights/next`. The shared layout mounts `SpeedInsights` under the same `VERCEL_ENV=production` condition as Web Analytics. Local and preview builds omit both components. Keep Speed Insights on the free tier; do not enable Speed Insights Plus.

The free tier reports the Real Experience Score and basic route breakdowns. It includes 10,000 events over a rolling 30-day window, shared across the team. Collection pauses at the limit without overage charges, and the website keeps running. These limits are separate from Web Analytics. See [Speed Insights pricing](https://vercel.com/docs/speed-insights/limits-and-pricing).

The SDK integration does not upgrade the Vercel project to Plus. After a production deployment, verify that the collection script loads and Vercel receives performance events. Local checks can verify the production condition and script initialization, but cannot prove Vercel ingestion.

Local verification on 15 October 2026 passed for builds with `VERCEL_ENV=preview` and `VERCEL_ENV=production`. Browser checks found no telemetry initialization in preview, including after navigation. The production build initialized one Speed Insights script and updated its route from `/` to `/docs` without adding another script. Docs type checks, formatting, link checks, and the browser smoke suite passed. React Doctor scored 100/100, and independent source review found no actionable issues. Vercel ingestion remains unverified until production deployment.
