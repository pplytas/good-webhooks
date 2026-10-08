import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

// The warehouse retains its signing secret encrypted with the host's persistent key.
// This is app-owned storage, separate from Good Webhooks' private tables.
export function sealSecret(secret: string, key: string) {
  const nonce = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(key, 'base64'), nonce)
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()])
  return Buffer.concat([nonce, cipher.getAuthTag(), ciphertext]).toString('base64')
}
export function openSecret(value: string, key: string) {
  const bytes = Buffer.from(value, 'base64')
  const decipher = createDecipheriv(
    'aes-256-gcm',
    Buffer.from(key, 'base64'),
    bytes.subarray(0, 12),
  )
  decipher.setAuthTag(bytes.subarray(12, 28))
  return Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8')
}
