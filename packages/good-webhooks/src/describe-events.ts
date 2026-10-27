import type { StandardJSONSchemaV1 } from '@standard-schema/spec'
import { validateEventDefinitions } from './config.js'
import { WebhookError } from './errors.js'
import type { EventDefinitions } from './types.js'

export interface EventDescription {
  /** The event name from the events map. */
  type: string
  /** JSON Schema of the payload receivers get, or null when the validator does not implement Standard JSON Schema. */
  schema: Record<string, unknown> | null
}

export interface DescribeEventsOptions {
  /** JSON Schema dialect passed to the validator. Defaults to 'draft-2020-12'. */
  target?: 'draft-2020-12' | 'draft-07' | (string & {})
  /** Vendor-specific options passed to the validator's converter, such as Zod's `{ unrepresentable: 'any' }`. */
  libraryOptions?: Record<string, unknown>
}

/**
 * Lists the event names in map order with the JSON Schema of each validated payload, for a
 * receiver-facing catalog. Validators that implement Standard JSON Schema describe their output
 * type; others get `schema: null`. Throws INVALID_CONFIG naming the event a validator cannot convert.
 */
export function describeEvents(
  events: EventDefinitions,
  options: DescribeEventsOptions = {},
): EventDescription[] {
  validateEventDefinitions(events)
  if (typeof options !== 'object' || options === null)
    throw new WebhookError('INVALID_INPUT', 'describeEvents options must be an object.')
  const target = options.target === undefined ? 'draft-2020-12' : options.target
  if (typeof target !== 'string' || target === '')
    throw new WebhookError('INVALID_INPUT', 'target must be a non-empty string.')
  const { libraryOptions } = options
  if (
    libraryOptions !== undefined &&
    (typeof libraryOptions !== 'object' || libraryOptions === null || Array.isArray(libraryOptions))
  )
    throw new WebhookError('INVALID_INPUT', 'libraryOptions must be an object.')
  const converterOptions: StandardJSONSchemaV1.Options =
    libraryOptions === undefined ? { target } : { target, libraryOptions }
  return Object.entries(events).map(([type, schema]) => ({
    type,
    schema: describeOutput(type, schema, converterOptions),
  }))
}

function describeOutput(
  type: string,
  schema: EventDefinitions[string],
  converterOptions: StandardJSONSchemaV1.Options,
): Record<string, unknown> | null {
  // Detected structurally, so no validator library is imported here.
  const converter = (schema['~standard'] as Partial<StandardJSONSchemaV1.Props>).jsonSchema
  if (typeof converter?.output !== 'function') return null
  let result: unknown
  try {
    // The output side: receivers get the validated value, so defaulted fields are present.
    result = converter.output(converterOptions)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    throw new WebhookError(
      'INVALID_CONFIG',
      `Event ${type} cannot be described as JSON Schema: ${message}`,
      { cause },
    )
  }
  if (typeof result !== 'object' || result === null || Array.isArray(result))
    throw new WebhookError(
      'INVALID_CONFIG',
      `Event ${type} cannot be described as JSON Schema: the validator returned no object.`,
    )
  return result as Record<string, unknown>
}
