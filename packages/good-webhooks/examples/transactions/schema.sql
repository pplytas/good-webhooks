-- Application-owned example tables. Apply separately from the Good Webhooks migration.
CREATE SCHEMA transaction_example;

CREATE TABLE transaction_example.invoices (
  organization_id text NOT NULL,
  invoice_id text NOT NULL,
  amount integer NOT NULL CHECK (amount >= 0),
  currency text NOT NULL,
  paid boolean NOT NULL DEFAULT false,
  PRIMARY KEY (organization_id, invoice_id)
);

-- The host checks endpoint ownership and maintains these invoice.paid routing rules.
-- Paused endpoints retain their routes. The worker resolves current endpoint lifecycle.
CREATE TABLE transaction_example.invoice_routes (
  organization_id text NOT NULL,
  endpoint_id text NOT NULL,
  currency text NOT NULL,
  minimum_amount integer NOT NULL DEFAULT 0 CHECK (minimum_amount >= 0),
  PRIMARY KEY (organization_id, endpoint_id, currency)
);
