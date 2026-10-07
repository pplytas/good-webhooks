import { WebhookError } from './errors.js'
import type { EventDefinitions, ResolvedConfig, DeliveryOptions } from './types.js'

function integer(name: string, value: unknown, fallback: number, min: number, max: number): number {
  const resolved = value ?? fallback
  if (
    typeof resolved !== 'number' ||
    !Number.isSafeInteger(resolved) ||
    resolved < min ||
    resolved > max
  ) {
    throw new WebhookError(
      'INVALID_CONFIG',
      `${name} must be an integer between ${min} and ${max}.`,
    )
  }
  return resolved
}

export function resolveConfig<E extends EventDefinitions>(
  options: DeliveryOptions<E>,
): ResolvedConfig {
  if (
    !options ||
    typeof options.database?.connect !== 'function' ||
    typeof options.database.query !== 'function'
  ) {
    throw new WebhookError(
      'INVALID_CONFIG',
      'database must provide PostgreSQL query() and connect() methods.',
    )
  }
  if (
    !options.events ||
    typeof options.events !== 'object' ||
    Object.keys(options.events).length === 0
  ) {
    throw new WebhookError(
      'INVALID_CONFIG',
      'Define at least one event with a Standard Schema validator.',
    )
  }
  for (const [name, schema] of Object.entries(options.events)) {
    if (
      !/^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,119}$/.test(name) ||
      typeof schema?.['~standard']?.validate !== 'function'
    ) {
      throw new WebhookError('INVALID_CONFIG', `Invalid event definition: ${name}.`)
    }
  }
  if (
    typeof options.source?.matchRecipients !== 'function' ||
    typeof options.source.resolveEndpoint !== 'function'
  )
    throw new WebhookError(
      'INVALID_CONFIG',
      'source must provide matchRecipients() and resolveEndpoint().',
    )
  if (options.allowLocalhost !== undefined && typeof options.allowLocalhost !== 'boolean') {
    throw new WebhookError('INVALID_CONFIG', 'allowLocalhost must be a boolean.')
  }
  const delays = options.retry?.delaysMs ?? [1000, 5000, 30000, 120000, 600000, 1800000]
  if (
    !Array.isArray(delays) ||
    delays.length > 20 ||
    delays.some((d) => !Number.isSafeInteger(d) || d < 1 || d > 86400000)
  ) {
    throw new WebhookError(
      'INVALID_CONFIG',
      'retry.delaysMs must contain at most 20 positive delays of at most one day.',
    )
  }
  const timeoutMs = integer('delivery.timeoutMs', options.delivery?.timeoutMs, 10000, 10, 120000)
  const leaseMs = integer('delivery.leaseMs', options.delivery?.leaseMs, 60000, 100, 3600000)
  if (leaseMs < timeoutMs * 2)
    throw new WebhookError(
      'INVALID_CONFIG',
      'delivery.leaseMs must be at least twice delivery.timeoutMs.',
    )
  const maxAgeMs = integer('retry.maxAgeMs', options.retry?.maxAgeMs, 86400000, 100, 2592000000)
  const retentionMs = integer('retentionMs', options.retentionMs, 604800000, 1000, 31536000000)
  if (retentionMs < maxAgeMs)
    throw new WebhookError('INVALID_CONFIG', 'retentionMs must be at least retry.maxAgeMs.')
  return Object.freeze({
    database: options.database,
    source: options.source,
    retryDelaysMs: Object.freeze([...delays]),
    maxAgeMs,
    timeoutMs,
    leaseMs,
    retentionMs,
    concurrency: integer('delivery.concurrency', options.delivery?.concurrency, 10, 1, 100),
    maxResponseBytes: integer(
      'delivery.maxResponseBytes',
      options.delivery?.maxResponseBytes,
      4096,
      0,
      65536,
    ),
    allowLocalhost: options.allowLocalhost ?? false,
  })
}
