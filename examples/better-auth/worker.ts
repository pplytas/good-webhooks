import { Pool } from 'pg'
import { createExampleAuth, type ExampleAuthOptions } from './auth.js'
import { createExampleDelivery } from './delivery.js'

/** Explicit worker entry function. Importing this module does not start it. */
export async function runExampleWorker(options: {
  auth: ExampleAuthOptions
  deliveryDatabaseUrl: string
  signal: AbortSignal
  onError: (error: unknown) => void
}) {
  // Use the app's same management filename, auth/plugin configuration, and retained secret keys.
  const { auth, database: managementDatabase } = createExampleAuth(options.auth)
  const deliveryDatabase = new Pool({ connectionString: options.deliveryDatabaseUrl })
  try {
    const delivery = await createExampleDelivery(auth, deliveryDatabase)
    await delivery.check()
    await delivery.worker.run({ signal: options.signal, onError: options.onError })
  } finally {
    await deliveryDatabase.end()
    managementDatabase.close()
  }
}
