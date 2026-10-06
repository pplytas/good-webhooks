# Receive typed webhooks

Use `parseWebhook()` from `webhook-dispatch/verify` to authenticate a Webhook Dispatch event and validate its payload. The receiver import loads no database, worker, or HTTP transport code.

## Share schemas for transmitted values

Keep your event map in a module that imports no server configuration or secrets:

```ts
// events.ts
import { z } from 'zod'

export const events = {
  'invoice.paid': z.object({ invoiceId: z.string(), amount: z.number().int().nonnegative() }),
  'account.activated': z.object({ accountId: z.string() }),
}
```

Pass this map to both `createWebhooks()` and `parseWebhook()`. Preserve its inferred type. An optional `satisfies EventDefinitions` constraint preserves inference, while an `: EventDefinitions` annotation widens it.

Share schemas that preserve values. Convert dollars to integer cents before publishing, for example. If a producer schema performs that conversion, reusing it on the receiver would convert the transmitted cents again. For an existing transforming producer, provide a separate receiver map that accepts the producer's output.

Receiver schemas may decode JSON into local values such as `Date`. The parser calls the selected schema's `~standard.validate()` once, awaits its result, and returns its output without revalidation. The schema provider controls how often it invokes its own callbacks. Keep validation and transforms free of business side effects.

## Authenticate and parse the body

Enforce an upload limit before buffering the HTTP body. The [Node.js receiver helper](../examples/basic/receiver.ts) reads chunks up to 512 KiB and returns `413` when that limit is exceeded. Configure equivalent limits in your HTTP framework or proxy.

```ts
import { parseWebhook, type ParsedWebhook } from 'webhook-dispatch/verify'
import { events } from './events.js'

// rawBody contains the original request bytes, read through a bounded HTTP reader.
const event = await parseWebhook({
  body: rawBody,
  headers: request.headers,
  secret: endpointSecret,
  events,
})

if (event.type === 'invoice.paid') {
  event.data.invoiceId // string
  event.data.amount // number
} else {
  event.data.accountId // string
}

type ReceivedEvent = ParsedWebhook<typeof events>
```

Read the endpoint secret from trusted configuration. Do not select a secret or scope from an unverified payload. The parser authenticates the signature before decoding JSON or calling a schema. It requires the body's `id` to match the authenticated `webhook-id`.

The input accepts a raw string or `Uint8Array`, native `Headers` or Node.js headers, and one secret or an array of secrets during rotation. Optional `now` and `toleranceSeconds` match `verifyWebhook()`. The default freshness tolerance is five minutes and applies to the signed attempt timestamp, not `occurredAt`.

The envelope requires its own `id`, `type`, `occurredAt`, and `data` fields. `occurredAt` uses the producer's UTC ISO format. Extra envelope fields are omitted. The selected schema decides how to handle extra payload fields. Only event names registered as own keys in the receiver map are accepted.

The parser caps the raw envelope at 512 KiB. Before schema execution, the JSON payload must fit the producer's 256 KiB size limit and maximum depth of 64 and contain only finite numbers. Byte input must use valid UTF-8. These bounds do not restrict the validator's decoded output. The parser's size check cannot undo an HTTP body allocation that already happened.

## Commit receiver work before acknowledging it

Use `event.id` for durable deduplication. In one application-owned transaction, insert a unique receipt for that ID and apply the business mutation only if the receipt is new. Commit before returning `2xx`. Acknowledge an already committed receipt without repeating the mutation.

The [runnable demo](../examples/basic/demo.ts) uses [separate application tables](../examples/basic/receiver.sql) for receipts and invoices. The library creates neither table. The demo verifies that a retry and replay produce one invoice mutation.

Map expected parser errors to `4xx` responses:

| Error code          | Meaning                                                                            |
| ------------------- | ---------------------------------------------------------------------------------- |
| `SIGNATURE_INVALID` | Missing, ambiguous, malformed, or invalid signature headers                        |
| `SIGNATURE_EXPIRED` | Attempt timestamp outside the configured tolerance                                 |
| `PAYLOAD_INVALID`   | Invalid encoding, JSON, envelope, bounds, event name, or validator-reported issues |

Keep trusted configuration failures, thrown or rejected validator exceptions, and business failures as `5xx` responses. The [receiver helper](../examples/basic/receiver.ts) demonstrates this distinction. A thrown validator exception is wrapped in an ordinary `Error` with its original cause, even when it throws a `WebhookError`.

Expected payload errors contain no raw payload or validator issue messages. Unexpected errors retain their cause for server-side diagnosis. Do not expose those causes in HTTP responses.

The sender treats most `4xx` responses as terminal. Do not catch every exception and return `400`. Unknown events also produce `PAYLOAD_INVALID`; there is no silent ignore mode.

## Retain compatible event definitions

Retries and replays keep the original body and event ID, even when the event predates the current schema deployment. Keep existing event names backward compatible. Use a new name such as `invoice.paid.v2` for a breaking payload change.

Deploy receiver support before enabling a new producer event. Keep old receiver schemas while retained events can still be retried or replayed. Sharing the latest schema file does not migrate stored event bodies.

## Use asynchronous Zod schemas safely

The installed Zod 4.6.5 Standard Schema implementation probes synchronously and then retries asynchronously. An async transform can run twice on the same input. If its first promise rejects, Zod can leave an unhandled rejection outside the promise returned to the parser.

For async Zod transforms or refinements, use the application-level [asyncZod example](../examples/basic/async-zod.ts). It implements Standard Schema through Zod's public [`safeParseAsync()`](https://zod.dev/basics#handling-errors) and preserves input and output inference:

```ts
import { z } from 'zod'
import { asyncZod } from './async-zod.js'

const receiverEvents = {
  'account.activated': asyncZod(
    z.object({ activatedAt: z.iso.datetime() }).transform(async (value) => ({
      activatedAt: new Date(value.activatedAt),
    })),
  ),
}
```

This workaround belongs to application code. The package has no Zod dependency or vendor-specific parser option. Synchronous Zod schemas work directly. Recheck the provider behavior before removing the workaround after a dependency update.

## Verify a different payload format

`verifyWebhook()` remains available for Standard Webhooks messages with a different payload format. It returns normally on success and throws on failure. It authenticates the exact body and timestamp but does not parse, validate, or deduplicate it. Standard Webhooks signing does not require the Webhook Dispatch JSON envelope.

```ts
import { verifyWebhook } from 'webhook-dispatch/verify'

verifyWebhook({ body: rawBody, headers: request.headers, secret: endpointSecret })
// Parse and validate your chosen format only after verification succeeds.
```
