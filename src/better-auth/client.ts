import type { BetterAuthClientPlugin } from 'better-auth'
import type { goodWebhooks } from './index.js'

/** Match the server event names to retain literal event types on the client. */
export function goodWebhooksClient<
  const EventTypes extends readonly string[] = readonly string[],
>(_options?: { eventTypes: EventTypes }) {
  return {
    id: 'good-webhooks',
    $InferServerPlugin: {} as ReturnType<typeof goodWebhooks<EventTypes>>,
    pathMethods: {
      '/good-webhooks/create': 'POST',
      '/good-webhooks/list': 'POST',
      '/good-webhooks/get': 'POST',
      '/good-webhooks/update': 'POST',
      '/good-webhooks/pause': 'POST',
      '/good-webhooks/resume': 'POST',
      '/good-webhooks/remove': 'POST',
      '/good-webhooks/rotate-secret': 'POST',
    },
    fetchPlugins: [
      {
        id: 'good-webhooks-json',
        name: 'Good Webhooks JSON responses',
        init(url, options) {
          if (!new URL(url, 'http://localhost').pathname.includes('/good-webhooks/'))
            return { url, ...(options ? { options } : {}) }
          return { url, options: { ...options, jsonParser: JSON.parse } }
        },
      },
    ],
  } satisfies BetterAuthClientPlugin
}
