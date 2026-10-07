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
