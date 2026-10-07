# Configure PostgreSQL namespaces explicitly

Standalone management and delivery default to `public` with tables prefixed by `webhook_`, and each accepts an explicit `schema` option. The host uses the same selection with `getPostgresMigration`, which returns SQL without applying it; combined setup shares one schema while injected management may use a separate schema or database. Better Auth management retains BA's model and field mapping conventions, with PostgreSQL placement controlled by the host's BA adapter or ORM configuration rather than inferred by the delivery module.
