/** Event types under this prefix belong to Good Webhooks; applications cannot define them. */
export const RESERVED_EVENT_PREFIX = 'good-webhooks.'
export const TEST_EVENT_TYPE = 'good-webhooks.test'

const EVENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/

/** Any well-formed event type, including reserved ones. Receivers use this for envelopes. */
export function isEventName(name: unknown): name is string {
  return typeof name === 'string' && EVENT_NAME.test(name)
}

/** An event type an application may define and subscribe to. */
export function isApplicationEventName(name: unknown): name is string {
  return isEventName(name) && !name.startsWith(RESERVED_EVENT_PREFIX)
}
