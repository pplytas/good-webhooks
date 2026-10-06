# Optional scopes with application-defined namespaces

Root operations use one application scope; `forScope({ type, id })` returns an immutable selection for an isolated named scope, while the host authorizes access. A structured namespace prevents overlapping user and organization IDs from colliding, at the cost of one extra field compared with a string key; v0 needs no scope configuration modes, identity tables, or authentication plugin. Root and named clients share the same operations, and only the root exposes database-wide worker execution and pruning.
