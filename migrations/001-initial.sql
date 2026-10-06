-- Apply explicitly with your migration runner, before starting the application.
-- PostgreSQL 16+. This migration is transactional and safe to apply once.
BEGIN;
CREATE SCHEMA IF NOT EXISTS webhooks;
CREATE TABLE webhooks.schema_version (version integer PRIMARY KEY);
INSERT INTO webhooks.schema_version VALUES (1);

CREATE TABLE webhooks.endpoints (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  url text NOT NULL,
  description text,
  event_types text[] NOT NULL CHECK (cardinality(event_types) > 0),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','deleted')),
  max_in_flight integer NOT NULL DEFAULT 2 CHECK (max_in_flight BETWEEN 1 AND 50),
  secret text NOT NULL,
  previous_secret text,
  previous_secret_expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id,id)
);
CREATE INDEX endpoints_tenant ON webhooks.endpoints(tenant_id,created_at,id);

CREATE TABLE webhooks.events (
  id uuid PRIMARY KEY,
  tenant_id text NOT NULL,
  type text NOT NULL,
  body text NOT NULL,
  fingerprint text NOT NULL,
  idempotency_key text,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  UNIQUE (tenant_id,id),
  UNIQUE (tenant_id,idempotency_key)
);
CREATE INDEX events_retention ON webhooks.events(created_at,id);

CREATE TABLE webhooks.deliveries (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  tenant_id text NOT NULL,
  endpoint_id uuid NOT NULL,
  event_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','in_flight','succeeded','failed','cancelled')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  next_attempt_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  claim_token uuid,
  lease_expires_at timestamptz,
  replay_of bigint REFERENCES webhooks.deliveries(id) ON DELETE CASCADE,
  last_error text,
  last_status integer,
  created_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  FOREIGN KEY (tenant_id,endpoint_id) REFERENCES webhooks.endpoints(tenant_id,id),
  FOREIGN KEY (tenant_id,event_id) REFERENCES webhooks.events(tenant_id,id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX deliveries_original ON webhooks.deliveries(event_id,endpoint_id) WHERE replay_of IS NULL;
CREATE UNIQUE INDEX deliveries_active_replay ON webhooks.deliveries(replay_of) WHERE replay_of IS NOT NULL AND status IN ('pending','in_flight');
CREATE INDEX deliveries_due ON webhooks.deliveries(next_attempt_at,id) WHERE status='pending';
CREATE INDEX deliveries_leases ON webhooks.deliveries(lease_expires_at) WHERE status='in_flight';
CREATE INDEX deliveries_endpoint ON webhooks.deliveries(endpoint_id,status,id);
CREATE INDEX deliveries_tenant ON webhooks.deliveries(tenant_id,id DESC);
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
COMMIT;
