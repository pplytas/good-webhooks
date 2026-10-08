CREATE TABLE "northstar".shop_orders (
  id uuid PRIMARY KEY,
  customer text NOT NULL,
  sku text NOT NULL,
  quantity integer NOT NULL CHECK (quantity BETWEEN 1 AND 100),
  total_cents integer NOT NULL CHECK (total_cents > 0),
  idempotency_key text UNIQUE NOT NULL,
  request_fingerprint text NOT NULL,
  event_id text NOT NULL,
  delivery_count integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "northstar".warehouse_config (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  endpoint_id text,
  secret_ciphertext text,
  mode text NOT NULL DEFAULT 'healthy' CHECK (mode IN ('healthy', 'reject')),
  duplicate_count integer NOT NULL DEFAULT 0,
  CHECK ((endpoint_id IS NULL) = (secret_ciphertext IS NULL))
);
INSERT INTO "northstar".warehouse_config (singleton) VALUES (true);
CREATE TABLE "northstar".warehouse_receipts (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "northstar".warehouse_shipments (
  event_id text PRIMARY KEY REFERENCES "northstar".warehouse_receipts(event_id),
  order_id uuid UNIQUE NOT NULL,
  customer text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE "northstar".worker_heartbeat (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  process_id integer NOT NULL,
  last_seen_at timestamptz NOT NULL,
  stopped_at timestamptz
);
