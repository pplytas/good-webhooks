import type {
  PauseReason,
  Scope,
  Endpoint,
  CreateEndpointInput,
  UpdateEndpointInput,
  EndpointWithSecret,
  TestEventResult,
} from '../types.js'

/** null identifies application scope, distinct from every named scope. */
export type ManagementScope = Scope | null
export type ManagedEndpoint = Endpoint
export type CreateManagedEndpoint = CreateEndpointInput
export type UpdateManagedEndpoint = UpdateEndpointInput
export type ManagedEndpointWithSecret = EndpointWithSecret

export type EndpointResolution =
  | {
      status: 'active'
      url: string
      secrets: readonly string[]
      /** Changes whenever the endpoint changes. Automatic pauses use it to ignore stale failures. */
      revision?: string
    }
  | { status: 'paused' | 'deleted' }

export type AutomaticPauseReason = Exclude<PauseReason, 'owner'>
export interface AutomaticPauseInput {
  reason: AutomaticPauseReason
  /** Pause only if the endpoint still has this revision. */
  revision?: string
}

/** Trusted server capability. Lookup failures reject; missing records resolve as deleted. */
export interface EndpointSource {
  matchRecipients(scope: ManagementScope, eventType: string): Promise<readonly string[]>
  resolveEndpoint(scope: ManagementScope, id: string): Promise<EndpointResolution>
  /**
   * Pause an active endpoint on the worker's behalf. Resolves false, without changing anything,
   * when the endpoint is no longer active or no longer has the given revision.
   */
  pause?(scope: ManagementScope, id: string, input: AutomaticPauseInput): Promise<boolean>
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
  /** Sign and send one test event to an active or paused endpoint. Records nothing. */
  sendTestEvent(scope: ManagementScope, id: string): Promise<TestEventResult>
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
  /**
   * Atomically insert a complete record unless the scope already has `limit` nondeleted
   * endpoints. `limit` is an integer from 0 to 1000. Reject with INVALID_STATE at the limit.
   */
  create(
    scope: ManagementScope,
    endpoint: Omit<StoredEndpoint, 'id'>,
    limit: number,
  ): Promise<StoredEndpoint>
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
  /** Most nondeleted endpoints a scope may have, from 0 to 1000. Defaults to 1000. */
  maxEndpoints?: EndpointLimit
}

/** Lowering a limit never removes endpoints; it only blocks new ones. */
export type EndpointLimit = (scope: ManagementScope) => number | Promise<number>
