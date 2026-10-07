-- Convenience migration for standalone management plus delivery.
-- Apply this once OR apply management.sql and delivery.sql separately, never both.

-- Standalone management only. Better Auth creates its own models with its schema tooling.
CREATE SCHEMA IF NOT EXISTS webhooks_management;

CREATE TABLE webhooks_management.endpoints (
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

CREATE INDEX endpoints_scope_idx ON webhooks_management.endpoints(scope_key)
  WHERE status <> 'deleted';

-- Delivery storage only. Management storage can live in a different database.
-- Apply explicitly with your migration runner, before starting the application.
-- PostgreSQL 16+. The caller must wrap this migration in one transaction.
-- With psql, use --single-transaction -v ON_ERROR_STOP=1. Apply once.
CREATE SCHEMA IF NOT EXISTS webhooks;
CREATE TABLE webhooks.schema_version (version integer PRIMARY KEY);
INSERT INTO webhooks.schema_version VALUES (3);

-- These rows coordinate sender capacity; they do not contain management records.
CREATE TABLE webhooks.endpoint_state (
  scope_key text NOT NULL,
  endpoint_id text NOT NULL,
  max_in_flight integer NOT NULL DEFAULT 2 CHECK (max_in_flight BETWEEN 1 AND 50),
  PRIMARY KEY (scope_key,endpoint_id)
);

CREATE TABLE webhooks.events (
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
CREATE INDEX events_retention ON webhooks.events(created_at,id);

CREATE TABLE webhooks.deliveries (
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
  FOREIGN KEY (scope_key,replay_of) REFERENCES webhooks.deliveries(scope_key,id) ON DELETE CASCADE,
  FOREIGN KEY (scope_key,endpoint_id) REFERENCES webhooks.endpoint_state(scope_key,endpoint_id),
  FOREIGN KEY (scope_key,event_id) REFERENCES webhooks.events(scope_key,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX deliveries_original ON webhooks.deliveries(event_id,endpoint_id) WHERE replay_of IS NULL;
CREATE UNIQUE INDEX deliveries_active_replay ON webhooks.deliveries(replay_of) WHERE replay_of IS NOT NULL AND status IN ('pending','in_flight');
CREATE INDEX deliveries_due ON webhooks.deliveries(next_attempt_at,id) WHERE status='pending';
CREATE INDEX deliveries_leases ON webhooks.deliveries(lease_expires_at) WHERE status='in_flight';
CREATE INDEX deliveries_endpoint ON webhooks.deliveries(scope_key,endpoint_id,status,id);
CREATE INDEX deliveries_scope ON webhooks.deliveries(scope_key,id DESC);
CREATE INDEX deliveries_event ON webhooks.deliveries(event_id);

CREATE TABLE webhooks.attempts (
  delivery_id bigint NOT NULL REFERENCES webhooks.deliveries(id) ON DELETE CASCADE,
  number integer NOT NULL CHECK (number > 0),
  started_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  finished_at timestamptz,
  outcome text NOT NULL DEFAULT 'started' CHECK (outcome IN ('started','succeeded','retry','failed','abandoned')),
  response_status integer,
  response_body text,
  error text,
  PRIMARY KEY (delivery_id,number)
);
