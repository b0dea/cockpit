# Tutorial: the synthetic example end to end

<!-- cockpit:verified version=0.0.0 -->

This walkthrough is for anyone evaluating cockpit before pointing it at a real product. It runs
cockpit on the synthetic example in this repository: you generate agent surfaces, then watch a
drift check catch a hand edit. It needs no credentials and no Docker.

Outputs below were captured from a real run on macOS; long lines and repeated rows are trimmed
with `...`, and absolute paths are shortened to `…`.

## Install cockpit

You need the Node.js and Git prerequisites from [Install cockpit](getting-started.md#install-cockpit).
The package itself is installed in the next step, inside the demo directory.

## Create the demo directory

Copy the example outside the cockpit checkout, so its generated files and Git repositories stay
out of this repository. Until the first release, build the tarball as in
[Install from source](getting-started.md#install-from-source) and install it in place of
`@b0dea/cockpit` below.

```sh
rm -rf "${TMPDIR:-/tmp}/cockpit-demo" && cp -R examples/synthetic "${TMPDIR:-/tmp}/cockpit-demo"
cd "${TMPDIR:-/tmp}/cockpit-demo"
npm init --yes
npm install --save-dev --save-exact @b0dea/cockpit
```

Now run the bootstrap block of [examples/synthetic/README.md](../examples/synthetic/README.md) in
this directory. It creates the product's two repositories under **repositories/**: **app**, a tiny
Node package with one commit, and **web**, an empty repository whose remote is a local bare
repository. The configuration declares both as siblings.

## Preview the generated files

```sh
./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run
```

<!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
```console
$ cockpit sync --config cockpit.toml --dry-run
write "AGENTS.md"
write "CLAUDE.md"
write "compose.generated.yml"
write "opencode.jsonc"
write ".agents/skills/cockpit-setup/SKILL.md"
write ".agents/skills/cockpit-setup/agents/openai.yaml"
...
write ".claude/agents/evaluator.md"
write ".claude/settings.json"
...
write ".cockpit/guards/bash-guard.sh"
write ".codex/agents/evaluator.toml"
write ".codex/config.toml"
write ".codex/hooks.json"
write ".opencode/agents/evaluator.md"
...
write ".opencode/plugin/cockpit-guards.js"
write "docs/cockpit/environment-decisions.md"
write "env/.secrets/.gitignore"
write "fixtures/personas.generated.ts"
write "repositories/app/.env.example"
write ".cockpit/generated-environment-ownership.json"
WARNING SURFACE_GENERATOR_TRUST_WARNING [claudecode:.claude/settings.json]: Claude Code permissions: writing 2 trust-affecting settings to .claude/settings.json; review them as you would a hook, ...
```

Nothing is written yet. The warning is deliberate: the generated Claude Code settings grant
access to the sibling directory and name the approved MCP servers, which deserves the same review
as a hook. Add `--json` to get the result, diagnostics and invocation metadata as
one JSON document on stdout.

## Apply the sync and set up

```sh
./node_modules/.bin/cockpit sync --config cockpit.toml
git -C repositories/app add .env.example
git -C repositories/app -c user.name=Synthetic -c user.email=synthetic@example.invalid commit --quiet -m 'generated synthetic template'
./node_modules/.bin/cockpit setup --config cockpit.toml
./node_modules/.bin/cockpit check --config cockpit.toml
```

`sync` writes everything the dry run listed, including **repositories/app/.env.example**, the
environment template for the app's stubbed vendor. It belongs to the app repository, so you commit
it there; `setup` refuses an untracked template. `setup` then verifies both repositories and
creates the ignored **.env** from the template. `check` recomputes every generated file and
compares it with disk:

<!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
```console
$ cockpit check --config cockpit.toml
WARNING SURFACE_GENERATOR_TRUST_WARNING [claudecode:.claude/settings.json]: Claude Code permissions: ...
```

Exit code 0: nothing has drifted.

## Look at what was generated

| Generated | What it is |
|---|---|
| AGENTS.md, CLAUDE.md | Shared root instructions in AGENTS.md; CLAUDE.md imports them with `@AGENTS.md`. Existing team text stays outside the regions cockpit writes. |
| .claude/, .codex/, .opencode/, .cursor/, .grok/, opencode.jsonc, .agents/skills/ | Each harness's generated skills, subagents, hooks and supported permissions, in its own spelling |
| .cockpit/guards/bash-guard.sh | The shared guard script. cockpit installs its hook for Claude Code, Codex CLI and OpenCode only, not for Cursor or Grok Build |
| compose.generated.yml | The Docker Compose project for the declared services, volumes and ports |
| docs/cockpit/environment-decisions.md | A dated record of every environment decision, generated from the declarations |
| fixtures/personas.generated.ts | Typed personas generated from the declared persona source |
| env/.secrets/.gitignore | An ignore boundary created before any secret material exists |
| .cockpit/generated-environment-ownership.json | The ownership manifest: what cockpit wrote and the bytes it expects |
| .cockpit/local/guard-identity | This machine's Node and cockpit handler identity for the guard. It ignores itself in Git, so the committed files stay identical on every clone; each clone's `sync` writes its own |

Open **.claude/settings.json** to see the guard wired in as a Claude Code PreToolUse hook. The
Codex and OpenCode files wire the same guard through their own hook mechanisms.

## Catch drift

Edit a generated file by hand, then check again:

```sh
echo "# edited by hand" >> compose.generated.yml
./node_modules/.bin/cockpit check --config cockpit.toml
```

<!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
```console
$ cockpit check --config cockpit.toml
ERROR GENERATED_ARTIFACT_DRIFT [compose.generated.yml]: owned generated artifact differs from canonical bytes Fix: npx --no cockpit sync --config '…/cockpit-demo/cockpit.toml'
...
```

`check` exits 2, names the file and prints the fix; it never repairs anything itself. A changed
skill file reports `SURFACE_STATE_CONFLICT` instead, because cockpit will not overwrite a surface
it can no longer prove it owns. Undo the edit or run the suggested `sync`, and `check` passes
again. Your own text outside a cockpit-owned region, such as notes at the end of AGENTS.md, is not
drift.

## Read the configuration

Open **cockpit.toml** in the demo directory. It is long because every value records where it came
from, but the shape is simple. The first sections:

```toml
[cockpit]
name = "synthetic-example"        # names this cockpit instance
siblings_root = "repositories"    # where the product's repositories live

[guards]
vendor_endpoint_hosts = [ "api.vendor.example.test" ]   # commands that reach this host are denied

[[sibling]]
slug = "app"                      # stable identifier used everywhere else
dir = "app"                       # directory under siblings_root
mount = "always"                  # how the stack uses it: always bind-mounted
acquire = "none"                  # how it reaches disk: must already exist
var = "APP_DIR"                   # variable exported with its path
toolchain = "node"                # selects the install policy below
purpose = "Synthetic application"

[[sibling.environment_files]]
template = ".env.example"         # tracked template in the sibling
instance = ".env"                 # ignored file setup creates from it

[[sibling]]
slug = "web"
dir = "web"
mount = "none"                    # read by agents, never mounted
acquire = "auto"                  # setup clones it from remote when missing
remote = "synthetic-web.git"
var = "WEB_DIR"
purpose = "Synthetic web repository"

[ports.bases]
APP_HOST_PORT = 4100              # port family base; up leases a free family

[[environment.install_policies]]
toolchain = "node"                # dependency install for node siblings
volume = "dependencies"
lockfile = "package-lock.json"
install = [ "npm", "ci" ]
load_probe = [ "node", "probe.mjs", "load" ]
```

The rest is `[environment.generated]`, the stack itself:

- **services**: the app service with a digest-pinned image, its command, ports, mounts, health
  probe and toolchain pins;
- **volumes**: a dependency volume and a product data volume;
- **data**: the `empty`, `seeded` and `restored` modes, each an ordered list of operations with a
  probe that proves the mode was reached;
- **vendors**: the messages vendor, stubbed, with its endpoint pinned to a local sink and an
  egress guard;
- **decisions**: one dated entry per service, volume, mount, port and vendor, rendered into the
  decisions file above.

Each operation and probe has a `provenance` table saying where the value came from. The
[configuration reference](configuration-reference.md) documents every field.

## What changes on a real product

The example declares services but ships no code to run, so it ends here. On a real product the
next commands are `up`, `preflight` and, for everyday work, `session`; they need Docker Compose and
a [measured container runtime](environment.md#measure-the-container-runtime). See
[Bring the product up](getting-started.md#bring-the-product-up) and
[Run an agent inside the environment](getting-started.md#run-an-agent-inside-the-environment).

## Clean up

Delete the demo directory when you are done:

```sh
rm -rf "${TMPDIR:-/tmp}/cockpit-demo"
```
