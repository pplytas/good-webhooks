-- Demo application tables, separate from the library's schema. Apply once in a transaction.
CREATE SCHEMA webhooks_example;
CREATE TABLE webhooks_example.receipts (
  event_id text PRIMARY KEY,
  received_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE webhooks_example.invoices (
  id text PRIMARY KEY,
  amount integer NOT NULL
);
