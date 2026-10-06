import type { StandardSchemaV1 } from '@standard-schema/spec'
import type { z } from 'zod'

// Optional application-level workaround for Zod's synchronous Standard Schema probe.
// The package itself accepts Standard Schema directly and has no Zod dependency.
export function asyncZod<S extends z.ZodType>(
  schema: S,
): StandardSchemaV1<z.input<S>, z.output<S>> {
  return {
    '~standard': {
      version: 1,
      vendor: 'application-zod-async',
      async validate(value) {
        const result = await schema.safeParseAsync(value)
        return result.success ? { value: result.data } : { issues: result.error.issues }
      },
    },
  }
}
