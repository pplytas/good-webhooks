import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { config } from './config.ts'
const key = Buffer.from(config.RECEIVER_ENCRYPTION_KEY, 'base64')
export function encryptSecret(secret: string) {
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  return Buffer.concat([
    iv,
    cipher.update(secret, 'utf8'),
    cipher.final(),
    cipher.getAuthTag(),
  ]).toString('base64')
}
export function decryptSecret(encoded: string) {
  const bytes = Buffer.from(encoded, 'base64')
  const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
  decipher.setAuthTag(bytes.subarray(-16))
  return Buffer.concat([decipher.update(bytes.subarray(12, -16)), decipher.final()]).toString(
    'utf8',
  )
}
