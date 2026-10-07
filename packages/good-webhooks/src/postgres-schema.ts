import { WebhookError } from './errors.js'

/** PostgreSQL truncates identifiers beyond 63 bytes. Reject them instead of targeting another schema. */
export function resolvePostgresSchema(schema: string = 'public'): string {
  if (
    typeof schema !== 'string' ||
    !schema.trim() ||
    new TextDecoder('utf-8', { ignoreBOM: true }).decode(new TextEncoder().encode(schema)) !==
      schema ||
    schema.includes('\0') ||
    new TextEncoder().encode(schema).length > 63
  ) {
    throw new WebhookError(
      'INVALID_CONFIG',
      'schema must be a nonblank, well-formed PostgreSQL identifier of at most 63 bytes without null bytes.',
    )
  }
  return schema
}

export function quotePostgresSchema(schema?: string): string {
  return `"${resolvePostgresSchema(schema).replaceAll('"', '""')}"`
}

/** Shared by runtime queries and migration generation. Never interpolate an unquoted identifier. */
export function postgresTables(schema?: string) {
  const namespace = quotePostgresSchema(schema)
  return {
    endpoints: `${namespace}."webhook_endpoints"`,
    endpointState: `${namespace}."webhook_endpoint_state"`,
    events: `${namespace}."webhook_events"`,
    deliveries: `${namespace}."webhook_deliveries"`,
    attempts: `${namespace}."webhook_attempts"`,
    schemaVersion: `${namespace}."webhook_schema_version"`,
  } as const
}
