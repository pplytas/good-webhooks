# Complete consumer integrations

These applications install `good-webhooks@0.1.0-alpha.4` from npm. They use independent package manifests and lockfiles outside the repository's pnpm workspace. You can copy either directory into another project without building the library.

| Application                                          | What it demonstrates                                                                                       | Local address           |
| ---------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ----------------------- |
| [Northstar Supply](order-fulfillment/README.md)      | Atomic order publication, signed warehouse delivery, retries, replay, and shipment deduplication           | `http://127.0.0.1:4311` |
| [Better Auth billing](better-auth-billing/README.md) | Authenticated endpoint management, user isolation, transactional invoice events, and receiver verification | `http://127.0.0.1:4312` |

Use Node.js 24, npm, and Docker with Compose. Each application has its own database and ports, so both can run together. In the chosen directory:

```sh
npm ci
docker compose up -d --wait
npm run setup
npm run dev
```

Setup explicitly initializes storage and saves generated secrets in an ignored `.env` file. Keep that file across restarts. The application, delivery worker, and receiver run in separate processes. The development command starts all three and stops them together.

Follow each application's walkthrough to create a delivery, simulate a failed receiver, inspect attempts, recover through replay, and verify deduplication. The displayed activity comes from the running application and database.

These examples bind to loopback for local use. The order application has a local administrator interface. The billing application demonstrates real Better Auth sessions. Before deploying an adapted application, configure its authentication, authorization, public destinations, secrets, migration process, worker supervision, and retention schedule.

## Verify an integration

After setup, run these commands in the example directory:

```sh
npm run typecheck
npm run build
npm test
```

Tests exercise HTTP requests and PostgreSQL with isolated test storage. See each README for the `TEST_DATABASE_URL` contract. CI runs both applications against the published package on PostgreSQL 16.

Each application's `FINDINGS.md` records development friction. The [combined assessment](../docs/consumer-integration-findings.md) separates changes made in these examples from proposed library and documentation improvements.
