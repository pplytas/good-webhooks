import { WebhookError } from './errors.js'
import { POSTGRES_SCHEMA_VERSION, postgresTables, quotePostgresSchema } from './postgres-schema.js'
import type { PostgresComponent } from './postgres-schema.js'

export { POSTGRES_SCHEMA_VERSION } from './postgres-schema.js'
export type { PostgresComponent } from './postgres-schema.js'

type Component = 'all' | PostgresComponent

function resolveComponent(value: unknown): Component {
  const component = value ?? 'all'
  if (component !== 'all' && component !== 'management' && component !== 'delivery')
    throw new WebhookError('INVALID_CONFIG', 'component must be all, management, or delivery.')
  return component
}

export interface PostgresMigrationOptions {
  /** PostgreSQL namespace, shared by both components unless generated separately. Defaults to public. */
  schema?: string
  /** Generate only the component you use, or both for standalone setup. Defaults to all. */
  component?: 'all' | 'management' | 'delivery'
}

/** Generate fresh-install SQL for the host's migration runner. Never connects or applies DDL. */
export function getPostgresMigration(options: PostgresMigrationOptions = {}): string {
  const component = resolveComponent(options.component)
  const tables = postgresTables(options.schema)
  const namespace = quotePostgresSchema(options.schema)
  const version = `CREATE TABLE IF NOT EXISTS ${tables.schemaVersion} (component text PRIMARY KEY, version integer NOT NULL CHECK (version > 0));`
  const management = `INSERT INTO ${tables.schemaVersion} (component, version) VALUES ('management', ${POSTGRES_SCHEMA_VERSION});

CREATE TABLE ${tables.endpoints} (
  id text PRIMARY KEY,
  scope_key text NOT NULL,
  url text NOT NULL,
  description text,
  event_types text[] NOT NULL CHECK (cardinality(event_types) BETWEEN 1 AND 100),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'deleted')),
  secret text NOT NULL,
  previous_secret text,
  previous_secret_expires_at timestamptz,
  revision integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK ((previous_secret IS NULL) = (previous_secret_expires_at IS NULL)),
  CHECK (status <> 'deleted' OR (secret = '' AND previous_secret IS NULL))
);

CREATE INDEX webhook_endpoints_scope_idx ON ${tables.endpoints}(scope_key)
  WHERE status <> 'deleted';`

  const delivery = `INSERT INTO ${tables.schemaVersion} (component, version) VALUES ('delivery', ${POSTGRES_SCHEMA_VERSION});

CREATE TABLE ${tables.endpointState} (
  scope_key text NOT NULL,
  endpoint_id text NOT NULL,
  max_in_flight integer NOT NULL DEFAULT 2 CHECK (max_in_flight BETWEEN 1 AND 50),
  PRIMARY KEY (scope_key,endpoint_id)
);

CREATE TABLE ${tables.events} (
  id uuid PRIMARY KEY,
  scope_key text NOT NULL,
  type text NOT NULL,
  body text NOT NULL,
  fingerprint text NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (scope_key,id),
  UNIQUE (scope_key,idempotency_key)
);
CREATE INDEX webhook_events_retention ON ${tables.events}(created_at,id);

CREATE TABLE ${tables.deliveries} (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  scope_key text NOT NULL,
  endpoint_id text NOT NULL,
  event_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','succeeded','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  preparing boolean NOT NULL DEFAULT false,
  claim_token uuid,
  lease_expires_at timestamptz,
  replay_of bigint,
  last_error text,
  last_status integer,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (scope_key,id),
  FOREIGN KEY (scope_key,replay_of) REFERENCES ${tables.deliveries}(scope_key,id) ON DELETE CASCADE,
  FOREIGN KEY (scope_key,endpoint_id) REFERENCES ${tables.endpointState}(scope_key,endpoint_id),
  FOREIGN KEY (scope_key,event_id) REFERENCES ${tables.events}(scope_key,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX webhook_deliveries_original ON ${tables.deliveries}(event_id,endpoint_id) WHERE replay_of IS NULL;
CREATE UNIQUE INDEX webhook_deliveries_active_replay ON ${tables.deliveries}(replay_of) WHERE replay_of IS NOT NULL AND status IN ('pending','in_flight');
CREATE INDEX webhook_deliveries_due ON ${tables.deliveries}(next_attempt_at,id) WHERE status='pending';
CREATE INDEX webhook_deliveries_leases ON ${tables.deliveries}(lease_expires_at) WHERE status='in_flight';
CREATE INDEX webhook_deliveries_endpoint ON ${tables.deliveries}(scope_key,endpoint_id,status,id);
CREATE INDEX webhook_deliveries_scope ON ${tables.deliveries}(scope_key,id DESC);
CREATE INDEX webhook_deliveries_event ON ${tables.deliveries}(event_id);

CREATE TABLE ${tables.attempts} (
  delivery_id bigint NOT NULL REFERENCES ${tables.deliveries}(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started','succeeded','retry','failed','abandoned')),
  response_status integer,
  response_body text,
  error text,
  PRIMARY KEY (delivery_id,number)
);`
  return (
    [
      '-- Generated by getPostgresMigration. Apply once in a transaction using your migration runner.',
      `CREATE SCHEMA IF NOT EXISTS ${namespace};`,
      version,
      ...(component === 'delivery' ? [] : [management]),
      ...(component === 'management' ? [] : [delivery]),
    ].join('\n\n') + '\n'
  )
}

export interface PostgresUpgradeOptions {
  /** PostgreSQL namespace the installation uses. Defaults to public. */
  schema?: string
  /** Upgrade only the component in this namespace, or both for a shared namespace. Defaults to all. */
  component?: 'all' | 'management' | 'delivery'
  /** The schema version currently recorded in the database. Only 3 can be upgraded. */
  from: number
}

/**
 * Generate upgrade SQL from a recorded schema version to the version this package needs.
 * Never connects or applies DDL. Each step checks the recorded version and fails inside the host's transaction otherwise.
 */
export function getPostgresUpgrade(options: PostgresUpgradeOptions): string {
  if (!options || typeof options !== 'object')
    throw new WebhookError(
      'INVALID_CONFIG',
      'from is required: the schema version recorded in the database.',
    )
  const component = resolveComponent(options.component)
  if (options.from !== 3)
    throw new WebhookError(
      'INVALID_CONFIG',
      options.from === POSTGRES_SCHEMA_VERSION
        ? `Schema version ${POSTGRES_SCHEMA_VERSION} is current; no upgrade is needed.`
        : 'from must be 3. Earlier prototype storage needs fresh storage; later versions need a newer package.',
    )
  const tables = postgresTables(options.schema)
  const steps = [
    `-- Generated by getPostgresUpgrade. Upgrades schema version 3 to ${POSTGRES_SCHEMA_VERSION}. Apply once in a transaction using your migration runner.`,
  ]
  const delivery = `DO $$ BEGIN
  IF (SELECT count(*) FROM ${tables.schemaVersion}) <> 1 OR NOT EXISTS (SELECT 1 FROM ${tables.schemaVersion} WHERE version = 3) THEN
    RAISE EXCEPTION 'good-webhooks: expected delivery schema version 3 in ${tables.schemaVersion.replaceAll("'", "''")} before upgrading to ${POSTGRES_SCHEMA_VERSION}';
  END IF;
END $$;
ALTER TABLE ${tables.schemaVersion} DROP CONSTRAINT webhook_schema_version_pkey;
ALTER TABLE ${tables.schemaVersion} ADD COLUMN component text;
UPDATE ${tables.schemaVersion} SET component = 'delivery', version = ${POSTGRES_SCHEMA_VERSION};
ALTER TABLE ${tables.schemaVersion}
  ALTER COLUMN component SET NOT NULL,
  ADD PRIMARY KEY (component),
  ADD CHECK (version > 0);`
  const management = `CREATE TABLE IF NOT EXISTS ${tables.schemaVersion} (component text PRIMARY KEY, version integer NOT NULL CHECK (version > 0));
INSERT INTO ${tables.schemaVersion} (component, version) VALUES ('management', ${POSTGRES_SCHEMA_VERSION});`
  // Delivery first: in a shared namespace it restructures the version table that the management row needs.
  if (component !== 'management') steps.push(delivery)
  if (component !== 'delivery') steps.push(management)
  return steps.join('\n\n') + '\n'
}
