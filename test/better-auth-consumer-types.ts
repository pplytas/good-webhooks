import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { goodWebhooks, createBetterAuthManagement } from '../src/better-auth/index.js'
import { goodWebhooksClient } from '../src/better-auth/client.js'

// Compiled, never run. Protect endpoint and client inference without widening to BetterAuthPlugin.
async function betterAuthConsumerTypes(headers: Headers) {
  const eventTypes = ['invoice.created', 'invoice.paid'] as const
  const auth = betterAuth({ plugins: [goodWebhooks({ eventTypes })] })
  const client = createAuthClient({ plugins: [goodWebhooksClient({ eventTypes })] })
  const body = {
    url: 'https://receiver.example/webhook',
    eventTypes: ['invoice.created'] as ['invoice.created'],
  }
  const serverResult = await auth.api.createWebhookEndpoint({ headers, body })
  const date: string = serverResult.endpoint.createdAt
  const event: 'invoice.created' | 'invoice.paid' = serverResult.endpoint.eventTypes[0]!
  const browserResult = await client.goodWebhooks.create(body)
  const clientDate: string | undefined = browserResult.data?.endpoint.createdAt
  await auth.api.updateWebhookEndpoint({ headers, body: { id: 'endpoint', description: null } })
  await client.goodWebhooks.rotateSecret({ id: 'endpoint', graceMs: 0 })
  await auth.api.createWebhookEndpoint({
    headers,
    // @ts-expect-error Subscription names are inferred from the server's configured event names.
    body: { ...body, eventTypes: ['unknown.event'] },
  })
  // @ts-expect-error Subscription names remain literal types in the client plugin.
  await client.goodWebhooks.create({ ...body, eventTypes: ['unknown.event'] })
  // @ts-expect-error Delivery settings do not belong to endpoint management.
  await client.goodWebhooks.create({ ...body, maxInFlight: 10 })
  // @ts-expect-error Ordinary reads cannot expose signing secrets.
  const secret = (await auth.api.getWebhookEndpoint({ headers, body: { id: 'endpoint' } })).secret
  // @ts-expect-error The management plugin provides no event publication route.
  await auth.api.publishWebhook({ body: { type: 'invoice.created', data: {} } })
  const management = await createBetterAuthManagement(auth)
  await management.source.matchRecipients(
    { type: 'user', id: 'trusted-user-id' },
    'invoice.created',
  )
  void [date, event, clientDate, secret]
}
void betterAuthConsumerTypes
