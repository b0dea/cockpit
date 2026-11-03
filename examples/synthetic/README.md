# Synthetic cockpit

The example the [tutorial](../../docs/tutorial.md) walks through: a product of two synthetic
local repositories and a stubbed vendor. It exercises `sync`, `setup` and
`check` with no credentials and no Docker.

From this directory, [install the exact project-local cockpit package](../../docs/getting-started.md#install-cockpit).
Until the first release, install from source: see [Install from source](../../docs/getting-started.md#install-from-source).

```sh human-only:package-install
npm init --yes
npm install --save-dev --save-exact @b00dea/cockpit
```

Then create the synthetic repositories once:

```sh human-only:bootstrap
mkdir -p repositories/app repositories/web fixtures
printf '[{"id":"synthetic"}]\n' > fixtures/personas.json
printf '.env\n' > repositories/app/.gitignore
printf '%s\n' '{"name":"synthetic-app","version":"0.0.0","scripts":{"build":"node --check probe.mjs","test":"node --check probe.mjs"}}' > repositories/app/package.json
printf '%s\n' '{"name":"synthetic-app","version":"0.0.0","lockfileVersion":3,"requires":true,"packages":{"":{"name":"synthetic-app","version":"0.0.0"}}}' > repositories/app/package-lock.json
printf 'process.exitCode = 0\n' > repositories/app/probe.mjs
git init --quiet .
git init --quiet repositories/app
git init --quiet repositories/web
git -C repositories/app add .gitignore package.json package-lock.json probe.mjs
git -C repositories/app -c user.name=Synthetic -c user.email=synthetic@example.invalid commit --quiet -m 'synthetic fixture'
```

The acceptance tests run the next block with the installed binary. Review the dry run before
`sync` creates the managed outputs, including the vendor environment template; do not create that
template by hand, because `sync` refuses an existing unmanaged file.

```sh executable
./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run --json
./node_modules/.bin/cockpit sync --config cockpit.toml --json
```

Review the generated template and track it in its owning repository before setup uses it:

```sh human-only:review-generated-template
git -C repositories/app add .env.example
git -C repositories/app -c user.name=Synthetic -c user.email=synthetic@example.invalid commit --quiet -m 'generated synthetic template'
```

`setup` validates both repositories and creates the ignored environment instance from the tracked
template; `check` verifies the managed outputs are current:

```sh executable
./node_modules/.bin/cockpit setup --config cockpit.toml --json
./node_modules/.bin/cockpit check --config cockpit.toml --json
```

The example has no service code, so it stops at `check`. To bring a stack up, use
[examples/minimal](../minimal/README.md).
