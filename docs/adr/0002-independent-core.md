# Keep the delivery core independent of authentication providers

The host establishes a trusted tenant context and the core enforces ownership for every tenant operation. Keeping provider-specific identities outside the core allows both direct server use and a future Better Auth plugin to call the same operations.

Database configuration, publication transactions, schema setup, and worker lifecycle remain explicit. A framework integration must not start delivery as a side effect of auth initialization or make delivery durability depend on an HTTP request lifecycle.
