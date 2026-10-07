# Use Better Auth schema and adapters for plugin management

The management plugin must support every database natively supported by its supported Better Auth versions, using the host's configured Better Auth adapter and normal plugin schema workflow. The optional delivery module's PostgreSQL requirement must not become a management requirement or force plugin consumers to change databases. Compatibility across native database types, schema generators, and concurrent operations is a release requirement to verify, not a capability already implemented.
