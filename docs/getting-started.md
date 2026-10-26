# Getting started

<!-- cockpit:verified version=0.0.0 -->

This guide is for an operator bringing up one product from a source checkout of cockpit. Cockpit
is currently private at version `0.0.0`, so these steps do not claim that an npm registry install
or a clean external machine has been verified.

## Install the current source

Building this checkout requires Node.js 22.13 or newer on a supported release line (22, 24, or 26).
Docker with Compose and Git are required by the environment
commands used below.

```sh
git clone https://github.com/b0dea/cockpit.git
cd cockpit
npm ci --ignore-scripts
npm run build
node packages/cockpit/bin/cockpit.mjs --help
```

Keep the absolute launcher path for the remaining commands:

```sh
export COCKPIT_LAUNCHER=/absolute/path/to/cockpit/packages/cockpit/bin/cockpit.mjs
```

The package is not yet public, and no literal clean-machine run of this sequence is recorded.
Treat both publication and clean-machine execution as operator-held evidence.

## Prepare a product checkout

From the root that will contain <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml`, preview one explicit harness bootstrap target:

```sh
node "$COCKPIT_LAUNCHER" init "$(pwd)" --target codexcli --json
```

Replace `codexcli` with `claudecode` or `opencode` when that is the harness being bootstrapped.
The preview does not publish files. Interactive mode displays the selected files and requires its
exact digest before publication:

```sh
node "$COCKPIT_LAUNCHER" init "$(pwd)" --target codexcli --interactive
```

For an existing registry, add `--registry /absolute/path/to/registry.toml`. Otherwise, init observes
bounded public package manifests and asks for unresolved configuration facts. Accepted answers are
bound to that observation and persisted for resume. Review the port map, generated environment
declaration and defaults before accepting the rendered configuration. Commands, images and health
checks that the checkout cannot establish need explicit operator answers.

With one repository, init offers stack scope: environment, seed and postures without estate registry,
projection or drift outputs. A checkout with no runnable product receives a named refusal and no
Compose output. Neither outcome establishes a running environment.

To inspect an established product before adopting it, use the read-only documentation path and
review every attributed value and gap:

```sh
node "$COCKPIT_LAUNCHER" document "$(pwd)" --json
```

The read-only document preview reports unresolved values, including <!-- cockpit:ref schema=ports.bases --> `ports.bases` when the source
does not establish a product port map. Complete those questions through interactive init; the draft
alone is not evidence of a valid configuration. A changed source observation invalidates prior
answers rather than silently reusing them.

The complete flags and outputs stay in the generated [CLI reference](cli-reference.md). The
generated [configuration reference](configuration-reference.md) is the source for fields and
defaults.

## Bring up a reviewed configuration

After <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` has been reviewed, run the lifecycle in order:

```sh
node "$COCKPIT_LAUNCHER" setup --config ./cockpit.toml
node "$COCKPIT_LAUNCHER" sync --config ./cockpit.toml --dry-run
node "$COCKPIT_LAUNCHER" sync --config ./cockpit.toml
node "$COCKPIT_LAUNCHER" check --config ./cockpit.toml
node "$COCKPIT_LAUNCHER" up --config ./cockpit.toml
node "$COCKPIT_LAUNCHER" preflight --config ./cockpit.toml
```

`sync --dry-run` is the mutation preview. Plain `sync` refuses any stale removal that needs
approval; use its named interactive procedure only after reviewing the exact request. A successful
`up` does not replace `preflight`: the latter is the authenticated environment gate. A
[Cockpit lifecycle record](concepts.md#cockpit-lifecycle-record) supports safe resume, but does not prove a
new attempt completed.

Read [Environment](environment.md) for lifecycle, ownership, and recovery semantics,
[Harness surfaces](harness-surfaces.md) for generated agent configuration, and
[Troubleshooting](troubleshooting.md) for current diagnostic remedies. Native harness loading,
in-session skill behavior, and a literal product run on a clean machine remain operator-held until
their dated evidence exists.
