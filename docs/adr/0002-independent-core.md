# Keep the delivery core independent of authentication providers

The host authorizes scope selection and the core enforces isolation for every operation. Keeping provider-specific identities outside the core allows both direct server use and a future Better Auth plugin to call the same operations.

Database configuration, publication transactions, schema setup, and worker lifecycle remain explicit. A framework integration must not start delivery as a side effect of auth initialization or make delivery durability depend on an HTTP request lifecycle.
