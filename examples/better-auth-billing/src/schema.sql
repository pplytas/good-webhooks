CREATE TABLE billing_invoices (
  id uuid PRIMARY KEY,
  owner_id text NOT NULL,
  customer text NOT NULL,
  total integer NOT NULL CHECK (total > 0),
  currency text NOT NULL DEFAULT 'EUR',
  status text NOT NULL CHECK (status IN ('open', 'paid')),
  created_at timestamptz NOT NULL DEFAULT now(),
  paid_at timestamptz
);
CREATE INDEX billing_invoices_owner ON billing_invoices (owner_id, created_at DESC);
CREATE TABLE billing_receivers (
  endpoint_id text PRIMARY KEY,
  owner_id text NOT NULL,
  route_id uuid NOT NULL UNIQUE,
  encrypted_secret text NOT NULL,
  mode text NOT NULL DEFAULT 'healthy' CHECK (mode IN ('healthy', 'reject')),
  connected_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE billing_receipts (
  endpoint_id text NOT NULL REFERENCES billing_receivers(endpoint_id),
  event_id uuid NOT NULL,
  event_type text NOT NULL,
  invoice_id uuid NOT NULL,
  payload jsonb NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint_id, event_id)
);
CREATE TABLE billing_receiver_invoices (
  endpoint_id text NOT NULL REFERENCES billing_receivers(endpoint_id),
  invoice_id uuid NOT NULL,
  customer text NOT NULL,
  total integer NOT NULL,
  currency text NOT NULL,
  status text NOT NULL CHECK (status IN ('open', 'paid')),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (endpoint_id, invoice_id)
);
CREATE TABLE billing_receiver_requests (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  endpoint_id text NOT NULL REFERENCES billing_receivers(endpoint_id),
  event_id uuid,
  outcome text NOT NULL CHECK (outcome IN ('accepted', 'duplicate', 'rejected', 'invalid')),
  received_at timestamptz NOT NULL DEFAULT now()
);
