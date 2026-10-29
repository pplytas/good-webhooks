import { afterAll, beforeEach, describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { WebhookError } from '../src/errors.js'
import { createWorkerStore, type DeliveryOutcome } from '../src/worker-store.js'
import type { ClaimedDelivery } from '../src/types.js'
import { closeDatabase, pool, resetDatabase, testConfig, testScopeKey, testStore } from './db.js'

const SCOPE = 'scope-a'
const TERMINAL = new Set(['succeeded', 'failed', 'cancelled'])
// A long lease keeps claims from expiring unless the run expires them.
const config = testConfig({ leaseMs: 60_000 })

type DeliveryRow = {
  id: string
  status: string
  attempt_count: number
  claim_token: string | null
  lease_expires_at: Date | null
  replay_of: string | null
}
type AttemptRow = { delivery_id: string; number: number; outcome: string }

const outcome: fc.Arbitrary<DeliveryOutcome> = fc.record({
  status: fc.constantFrom(200, 201, 204, 400, 404, 410, 429, 500, 503, null),
  responseBody: fc.constant(''),
  error: fc.option(fc.constantFrom('connect ECONNREFUSED', 'timeout'), { nil: null }),
  retryable: fc.boolean(),
  abandoned: fc.constantFrom(false, false, false, true),
  retryAfterMs: fc.option(fc.integer({ min: 0, max: 120_000 }), { nil: null }),
})
const operation = fc.oneof(
  { weight: 3, arbitrary: fc.constant({ kind: 'due' as const }) },
  { weight: 4, arbitrary: fc.constant({ kind: 'claim' as const }) },
  {
    weight: 4,
    arbitrary: fc.record({ kind: fc.constant('complete' as const), pick: fc.nat(), outcome }),
  },
  { weight: 1, arbitrary: fc.record({ kind: fc.constant('expire' as const), pick: fc.nat() }) },
  { weight: 2, arbitrary: fc.record({ kind: fc.constant('replay' as const), pick: fc.nat() }) },
  {
    weight: 1,
    arbitrary: fc.constantFrom({ kind: 'pause' as const }, { kind: 'resume' as const }),
  },
  { weight: 1, arbitrary: fc.constant({ kind: 'delete' as const }) },
)
type Operation = typeof operation extends fc.Arbitrary<infer T> ? T : never

async function snapshot() {
  const deliveries = await pool.query<DeliveryRow>(
    `SELECT id::text,status,attempt_count,claim_token,lease_expires_at,replay_of::text
    FROM public.webhook_deliveries WHERE scope_key=$1 ORDER BY id`,
    [testScopeKey(SCOPE)],
  )
  const attempts = await pool.query<AttemptRow>(
    `SELECT a.delivery_id::text,a.number,a.outcome FROM public.webhook_attempts a
    JOIN public.webhook_deliveries d ON d.id=a.delivery_id WHERE d.scope_key=$1
    ORDER BY a.delivery_id,a.started_at,a.number`,
    [testScopeKey(SCOPE)],
  )
  return { deliveries: deliveries.rows, attempts: attempts.rows }
}

/** Ignore the documented refusals (paused, deleted, replay already pending) and nothing else. */
async function allowRefusal(action: Promise<unknown>) {
  await action.catch((error: unknown) => {
    if (!(error instanceof WebhookError)) throw error
  })
}

beforeEach(resetDatabase)
afterAll(closeDatabase)

describe('delivery state machine properties', () => {
  it('keeps attempt and lease invariants across any sequence of worker and owner operations', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.array(operation, { minLength: 10, maxLength: 25 }),
        async (operations) => {
          await resetDatabase()
          const store = testStore(config)
          const worker = createWorkerStore(config)
          const { endpoint } = await store.createEndpoint(SCOPE, {
            url: 'http://127.0.0.1:9/webhook',
            eventTypes: ['test.sent'],
          })
          for (let n = 0; n < 3; n++) await store.publish(SCOPE, { type: 'test.sent', data: { n } })

          const held: ClaimedDelivery[] = []
          let previous = new Map((await snapshot()).deliveries.map((row) => [row.id, row]))
          const take = (pick: number) => held.splice(pick % held.length, 1)[0]!

          for (const op of operations as Operation[]) {
            const claimed = new Map<string, number>()
            if (op.kind === 'due') {
              await pool.query(
                "UPDATE public.webhook_deliveries SET next_attempt_at=now()-interval '1 second' WHERE status='pending'",
              )
            } else if (op.kind === 'claim') {
              const { claims, errors } = await worker.claim()
              expect(errors).toEqual([])
              for (const claim of claims) claimed.set(claim.id, (claimed.get(claim.id) ?? 0) + 1)
              held.push(...claims)
            } else if (op.kind === 'complete' && held.length) {
              await worker.complete(take(op.pick), op.outcome)
            } else if (op.kind === 'expire' && held.length) {
              // The claim stays held, so a later completion exercises the stale path.
              const claim = held[op.pick % held.length]!
              await pool.query(
                `UPDATE public.webhook_deliveries SET lease_expires_at=now()-interval '1 second'
              WHERE id=$1 AND claim_token=$2 AND status='in_flight'`,
                [claim.id, claim.token],
              )
              await worker.recoverExpired()
            } else if (op.kind === 'replay') {
              const originals = [...previous.values()].filter(
                (row) => row.replay_of === null && TERMINAL.has(row.status),
              )
              if (originals.length)
                await allowRefusal(store.replay(SCOPE, originals[op.pick % originals.length]!.id))
            } else if (op.kind === 'pause') {
              await allowRefusal(store.pauseEndpoint(SCOPE, endpoint.id))
            } else if (op.kind === 'resume') {
              await allowRefusal(store.resumeEndpoint(SCOPE, endpoint.id))
            } else if (op.kind === 'delete') {
              await allowRefusal(store.removeEndpoint(SCOPE, endpoint.id))
            }

            const { deliveries, attempts } = await snapshot()
            for (const row of deliveries) {
              const before = previous.get(row.id)
              if (before && TERMINAL.has(before.status)) {
                expect(row).toMatchObject({
                  status: before.status,
                  attempt_count: before.attempt_count,
                })
              }
              expect(row.attempt_count).toBe(
                (before?.attempt_count ?? 0) + (claimed.get(row.id) ?? 0),
              )
              const own = attempts.filter((attempt) => attempt.delivery_id === row.id)
              expect(own.map((attempt) => attempt.number)).toEqual(
                Array.from({ length: row.attempt_count }, (_, n) => n + 1),
              )
              const started = own.filter((attempt) => attempt.outcome === 'started')
              expect(started.length).toBeLessThanOrEqual(row.status === 'in_flight' ? 1 : 0)
              const leased = row.claim_token !== null && row.lease_expires_at !== null
              const free = row.claim_token === null && row.lease_expires_at === null
              expect(row.status === 'in_flight' ? leased : free).toBe(true)
            }
            expect(deliveries.length).toBeGreaterThanOrEqual(previous.size)
            previous = new Map(deliveries.map((row) => [row.id, row]))
          }
        },
      ),
      { numRuns: 25 },
    )
  })
})
