import type { BetterAuthPlugin } from 'better-auth'

const fields = {
  scopeKey: { type: 'string', required: true, input: false, returned: false },
  allocationKey: { type: 'string', required: true, input: false, returned: false },
  creationToken: { type: 'string', required: true, input: false, returned: false },
  url: { type: 'string', required: true },
  description: { type: 'string', required: false },
  eventTypes: { type: 'string[]', required: true },
  // BA's SQL Server generator uses varchar(8000) for arrays. Two 50-name chunks
  // preserve the existing 100 subscriptions of up to 120 ASCII characters.
  additionalEventTypes: {
    type: 'string[]',
    required: true,
    defaultValue: () => [],
    input: false,
    returned: false,
  },
  status: { type: 'string', required: true },
  encryptedSecret: { type: 'string', required: true, input: false, returned: false },
  previousEncryptedSecret: { type: 'string', required: false, input: false, returned: false },
  previousSecretExpiresAt: { type: 'date', required: false, input: false, returned: false },
  revision: { type: 'number', required: true, defaultValue: 0, input: false, returned: false },
  createdAt: { type: 'date', required: true },
  updatedAt: { type: 'date', required: true },
} as const satisfies NonNullable<BetterAuthPlugin['schema']>[string]['fields']

export type WebhookEndpointField = keyof typeof fields
export interface BetterAuthManagementSchemaOptions {
  modelName?: string
  fields?: Partial<Record<WebhookEndpointField, string>>
}

/** Physical names are configurable; repository operations use these logical field names. */
export function createBetterAuthManagementSchema(options: BetterAuthManagementSchemaOptions = {}) {
  return {
    webhookEndpoint: {
      modelName: options.modelName ?? 'webhookEndpoint',
      fields: Object.fromEntries(
        Object.entries(fields).map(([name, field]) => [
          name,
          {
            ...field,
            ...(options.fields?.[name as WebhookEndpointField] === undefined
              ? {}
              : { fieldName: options.fields[name as WebhookEndpointField] }),
          },
        ]),
      ),
      // MongoDB creates table-level indexes before writes; field.unique alone is insufficient.
      indexes: [{ fields: ['allocationKey'], unique: true }],
    },
  } satisfies NonNullable<BetterAuthPlugin['schema']>
}
