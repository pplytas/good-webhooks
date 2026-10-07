import { betterAuth } from 'better-auth'
import { createAuthClient } from 'better-auth/client'
import { createWebhooks, type Database } from 'good-webhooks'
import { goodWebhooks } from 'good-webhooks/better-auth'
import { goodWebhooksClient } from 'good-webhooks/better-auth/client'
import { z } from 'zod'

// Compile this file against the built public package; never execute it.
async function checkDocumentedTypes(database: Database, headers: Headers) {
  //#region delivery
  const events = {
    'invoice.created': z.object({ id: z.string(), amount: z.number() }),
  }
  const webhooks = createWebhooks({ database, events, encryptionKey: new Uint8Array(32) })
  await webhooks.publish({
    type: 'invoice.created',
    data: { id: 'invoice-1', amount: 1250 },
  })
  //#endregion

  // @ts-expect-error The event schema requires a numeric amount.
  await webhooks.publish({ type: 'invoice.created', data: { id: 'invoice-1', amount: '1250' } })
  // @ts-expect-error Subscriptions retain the event map's literal names.
  await webhooks.endpoints.create({ url: 'https://receiver.example/hook', eventTypes: ['unknown'] })

  //#region better-auth
  const eventTypes = ['invoice.created', 'invoice.paid'] as const
  const auth = betterAuth({ plugins: [goodWebhooks({ eventTypes })] })
  const client = createAuthClient({ plugins: [goodWebhooksClient({ eventTypes })] })

  const result = await client.goodWebhooks.create({
    url: 'https://receiver.example/hook',
    eventTypes: ['invoice.created'],
  })
  //#endregion

  const resultDate: string | undefined = result.data?.endpoint.createdAt
  const created = await auth.api.createWebhookEndpoint({
    headers,
    body: { url: 'https://receiver.example/hook', eventTypes: ['invoice.paid'] },
  })
  const eventName: 'invoice.created' | 'invoice.paid' | undefined = created.endpoint.eventTypes[0]
  await client.goodWebhooks.create({
    url: 'https://receiver.example/hook',
    // @ts-expect-error The client must preserve the server's configured event names.
    eventTypes: ['unknown'],
  })
  await auth.api.createWebhookEndpoint({
    headers,
    // @ts-expect-error The server must preserve the configured event names too.
    body: { url: 'https://receiver.example/hook', eventTypes: ['unknown'] },
  })
  void [resultDate, eventName]
}
void checkDocumentedTypes
