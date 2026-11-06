# Docs-only cockpit

A cockpit with no `[environment]`, for a repository of documents or a product not yet built.
`sync` publishes the agent surfaces and `check` drift-checks them. Runtime commands such as `up`
refuse with `ENVIRONMENT_NOT_DECLARED` and exit 2, and `doctor` reports no runtime declared.
[Install cockpit as an exact project-local dependency](../../docs/getting-started.md#install-cockpit)
before running the example.

```sh executable
./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml --json
./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml --json
./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config cockpit.toml --json
```
