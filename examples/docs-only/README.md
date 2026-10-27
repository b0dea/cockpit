# Docs-only cockpit

<!-- cockpit:verified version=0.0.0 -->

A cockpit with no `[environment]`, for a repository of documents or a product not yet built.
`sync` publishes the agent surfaces and `check` drift-checks them. Runtime commands such as
`up` refuse with `ENVIRONMENT_NOT_DECLARED` and exit 2, and `doctor` reports the runtime as not declared.

```sh executable
cockpit sync --config cockpit.toml --json
cockpit check --config cockpit.toml --json
cockpit up --config cockpit.toml --json
```
