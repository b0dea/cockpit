# Synthetic cockpit

<!-- cockpit:verified version=0.0.0 -->

This example uses two synthetic working repositories and one local bare remote. From this
directory, install the exact project-local cockpit package:

```sh human-only:package-install
npm init --yes
npm install --save-dev --save-exact @b0dea/cockpit
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
git init --quiet --bare repositories/synthetic-web.git
git -C repositories/web remote add origin synthetic-web.git
git -C repositories/app add .gitignore package.json package-lock.json probe.mjs
git -C repositories/app -c user.name=Synthetic -c user.email=synthetic@example.invalid commit --quiet -m 'synthetic fixture'
```

Both sibling repositories now exist. The following inventory is executed in CI with the installed
`cockpit` binary. Review the dry run before `sync` creates the managed outputs, including the vendor
environment template. Do not create that template by hand: an existing unmanaged file is refused.

```sh executable
cockpit sync --config cockpit.toml --dry-run --json
cockpit sync --config cockpit.toml --json
```

Review the generated template and track it in its owning repository before setup uses it:

```sh human-only:review-generated-template
git -C repositories/app add .env.example
git -C repositories/app -c user.name=Synthetic -c user.email=synthetic@example.invalid commit --quiet -m 'generated synthetic template'
```

`setup` validates both repositories and initializes the ignored environment instance from the
tracked template. `check` verifies that the managed outputs remain current:

```sh executable
cockpit setup --config cockpit.toml --json
cockpit check --config cockpit.toml --json
```

Starting or stopping a product runtime is intentionally outside this empty example. These
commands are human-only because a consumer must first supply real service declarations:

```sh human-only:runtime
cockpit preflight --config cockpit.toml --json
cockpit up --config cockpit.toml --json
cockpit down --config cockpit.toml --json
```
