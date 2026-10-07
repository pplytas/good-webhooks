import type {
  Scope,
  Endpoint,
  CreateEndpointInput,
  UpdateEndpointInput,
  EndpointWithSecret,
} from '../types.js'

/** null identifies application scope, distinct from every named scope. */
export type ManagementScope = Scope | null
export type ManagedEndpoint = Endpoint
export type CreateManagedEndpoint = CreateEndpointInput
export type UpdateManagedEndpoint = UpdateEndpointInput
export type ManagedEndpointWithSecret = EndpointWithSecret

export type EndpointResolution =
  { status: 'active'; url: string; secrets: readonly string[] } | { status: 'paused' | 'deleted' }

/** Trusted server capability. Lookup failures reject; missing records resolve as deleted. */
export interface EndpointSource {
  matchRecipients(scope: ManagementScope, eventType: string): Promise<readonly string[]>
  resolveEndpoint(scope: ManagementScope, id: string): Promise<EndpointResolution>
}

export interface EndpointManagement {
  readonly source: EndpointSource
  create(scope: ManagementScope, input: CreateManagedEndpoint): Promise<ManagedEndpointWithSecret>
  list(scope: ManagementScope): Promise<ManagedEndpoint[]>
  get(scope: ManagementScope, id: string): Promise<ManagedEndpoint>
  update(scope: ManagementScope, id: string, patch: UpdateManagedEndpoint): Promise<ManagedEndpoint>
  pause(scope: ManagementScope, id: string): Promise<ManagedEndpoint>
  resume(scope: ManagementScope, id: string): Promise<ManagedEndpoint>
  remove(scope: ManagementScope, id: string): Promise<ManagedEndpoint>
  rotateSecret(
    scope: ManagementScope,
    id: string,
    options?: { graceMs?: number },
  ): Promise<ManagedEndpointWithSecret>
  removeScope(scope: ManagementScope): Promise<void>
  /** Re-encrypt live endpoint secrets with the current storage key, preserving signing values. */
  reencrypt(scope: ManagementScope): Promise<number>
}

/** Persistence contract for management providers. Never expose stored records to clients. */
export interface StoredEndpoint extends ManagedEndpoint {
  revision: number
  encryptedSecret: string
  previousEncryptedSecret: string | null
  previousSecretExpiresAt: Date | null
}
export type StoredEndpointPatch = Partial<Omit<StoredEndpoint, 'id' | 'createdAt' | 'revision'>>

export interface ManagementRepository {
  /** Return every live endpoint in scope. Never truncate; enforce the 1000 endpoint bound. */
  list(scope: ManagementScope): Promise<StoredEndpoint[]>
  get(scope: ManagementScope, id: string): Promise<StoredEndpoint | null>
  /** Atomically insert a complete record while enforcing the strict per-scope bound. */
  create(scope: ManagementScope, endpoint: Omit<StoredEndpoint, 'id'>): Promise<StoredEndpoint>
  /** Atomically guard on scope/id/revision, increment revision, and apply the patch. */
  update(
    scope: ManagementScope,
    id: string,
    revision: number,
    patch: StoredEndpointPatch,
  ): Promise<StoredEndpoint | null>
}

export interface SecretCipher {
  encrypt(value: string): Promise<string>
  decrypt(value: string): Promise<string>
}

export interface ManagementOptions {
  repository: ManagementRepository
  cipher: SecretCipher
  eventTypes: readonly string[]
  allowLocalhost?: boolean
  /** Optional host validation after portable URL checks, for example DNS admission checks. */
  validateUrl?: (url: string) => Promise<void>
  /** Verify the owning user/organization still exists. Failures must reject. */
  scopeExists?: (scope: ManagementScope) => Promise<boolean>
}
