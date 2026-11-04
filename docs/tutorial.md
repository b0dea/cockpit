# Tutorial: the compose-first example end to end

This walkthrough is for anyone evaluating cockpit before pointing it at a real product. It runs
cockpit on the compose-first example in this repository: you generate agent surfaces, watch a
drift check catch a hand edit, and optionally bring the two-service stack up. It needs no
credentials. `check` reads the Compose file through `docker compose config`, so you need the Docker
CLI with Compose; only the last, optional step starts containers.

Outputs below were captured from a real run on macOS; long lines and repeated rows are trimmed
with `...`, and absolute paths are shortened to `…`.

## Install cockpit

You need the Node.js and Git prerequisites from [Install cockpit](getting-started.md#install-cockpit).
The package itself is installed in the next step, inside the demo directory.

## Create the demo directory

Copy the example outside the cockpit checkout, so its generated files stay out of this repository.

```sh
rm -rf "${TMPDIR:-/tmp}/cockpit-demo" && cp -R examples/compose-first "${TMPDIR:-/tmp}/cockpit-demo"
cd "${TMPDIR:-/tmp}/cockpit-demo"
git init --quiet .
npm init --yes
npm install --save-dev --save-exact @b00dea/cockpit
```

The example's **compose.yml** runs two tiny Node services, **api** and **web**, each built from its
directory and declared in **cockpit.toml** as a sibling that already exists on disk
(`acquire = "none"`).

## Preview the generated files

```sh
./node_modules/.bin/cockpit sync --config cockpit.toml --dry-run
```

```console
write "package.json"
write ".gitignore"
write "AGENTS.md"
write "CLAUDE.md"
write "compose.cockpit.yml"
write "opencode.jsonc"
write ".agents/skills/cockpit-explain/SKILL.md"
...
write ".opencode/plugin/cockpit-guards.js"
write ".opencode/skills/cockpit-setup/references/test-data-and-personas.md"
write ".cockpit/generated-environment-ownership.json"
WARNING SURFACE_GENERATOR_TRUST_WARNING [claudecode:.claude/settings.json]: Claude Code permissions: writing 2 trust-affecting settings to .claude/settings.json; review them as you would a hook because synced agent settings can widen filesystem access, approve project servers or run commands without asking. 'permissions.additionalDirectories' — moves the boundary of what Claude Code may read and edit outside the project: "api", "web"; 'permissions.allow' — lets Claude Code run 46 command patterns without asking; the file lists each one.
```

Nothing is written yet. `package.json` and `.gitignore` get the `cockpit:*` scripts and a marked
ignore block. **compose.cockpit.yml** is the override cockpit owns: it labels every service, network
and volume of your Compose file so runtime commands can tell what belongs to this stack. The
warning is deliberate: the generated Claude Code settings grant access to the sibling directories
and let Claude Code run cockpit's own commands without asking, which deserves the same review as a
hook. It appears only when a sync writes those settings. Add `--json` to get the result,
diagnostics and invocation metadata as one JSON document on stdout.

## Apply the sync and check it

```sh
./node_modules/.bin/cockpit sync --config cockpit.toml
./node_modules/.bin/cockpit check --config cockpit.toml
```

`check` recomputes every generated file, compares it with disk, and validates **compose.yml**:

```console
WARNING CODEX_HOOK_UNTRUSTED [.codex/hooks.json]: Codex has not trusted the guard hook in …/cockpit-demo/.codex/hooks.json on this machine, so a Codex session started there skips it and runs tool calls without the guard Guidance: if you use Codex in this cockpit, a person runs codex -C <cockpit root> in a terminal (not codex exec), trusts the folder if asked, and chooses "Trust all and continue" when Codex shows "Hooks need review" ...
```

Exit code 0: nothing has drifted. The warning only matters if you use Codex: it names the one-time trust step Codex needs before it runs the guard hook.

## Look at what was generated

| Generated | What it is |
|---|---|
| AGENTS.md, CLAUDE.md | Shared root instructions in AGENTS.md; CLAUDE.md imports them with `@AGENTS.md`. Existing team text stays outside the regions cockpit writes. |
| .claude/, .codex/, .opencode/, opencode.jsonc, .agents/skills/ | Each listed harness's generated skills, subagents, hooks and supported permissions, in its own spelling (`.cursor/` and `.grok/` too once `[surfaces] tools` lists them) |
| .cockpit/guards/bash-guard.sh | The shared guard script. cockpit installs its hook for Claude Code, Codex CLI and OpenCode only, not for Cursor or Grok Build |
| compose.cockpit.yml | The ownership override cockpit adds after your Compose file; it never edits **compose.yml** |
| .cockpit/generated-environment-ownership.json | The ownership manifest: what cockpit wrote and the bytes it expects |
| .cockpit/local/guard-identity | This machine's Node and cockpit handler identity for the guard. It ignores itself in Git, so the committed files stay identical on every clone; each clone's `sync` writes its own |

Open **.claude/settings.json** to see the guard wired in as a Claude Code PreToolUse hook. The
Codex and OpenCode files wire the same guard through their own hook mechanisms.

## Catch drift

Edit a generated file by hand, then check again:

```sh
echo "# edited by hand" >> compose.cockpit.yml
./node_modules/.bin/cockpit check --config cockpit.toml
```

```console
ERROR GENERATED_ARTIFACT_DRIFT [compose.cockpit.yml]
What failed: owned generated artifact differs from canonical bytes
Why it matters: generated files no longer match the canonical cockpit configuration
Fix: npx --no cockpit sync --config …/cockpit-demo/cockpit.toml
```

`check` exits 2, names the file and prints the fix; it never repairs anything itself. Run the
suggested `sync`, which rewrites the file, and `check` passes again. A changed skill file reports
`SURFACE_STATE_CONFLICT` instead, and `sync` refuses it too, because cockpit will not overwrite a
hand edit: move the change into `cockpit.toml` or a surface overlay, and ask the person who owns the
cockpit before you discard it. Your own text outside a cockpit-owned region, such as notes at the
end of AGENTS.md, is not drift. Neither is an edit to **compose.yml**: that file is yours, and
`check` validates it rather than comparing it with anything.

## Read the configuration

Open **cockpit.toml** in the demo directory:

```toml
[cockpit]
name = "duo"                      # names this cockpit instance
siblings_root = "."               # where the product's repositories live

[[sibling]]
slug = "api"                      # stable identifier used everywhere else
dir = "api"                       # directory under siblings_root
mount = "always"                  # compose.yml must bind-mount it
acquire = "none"                  # how it reaches disk: must already exist
var = "API_DIR"                   # variable Compose receives with its path
purpose = "Tiny JSON api"

[ports.bases]
API_HOST_PORT = 4200              # port family base; up leases a free family
WEB_HOST_PORT = 4300

[environment]
compose_files = ["compose.yml"]   # the stack, run as written
```

The rest declares the second sibling, how the product is reached locally (`addressing`,
`authentication`) and the least the container runtime must offer (`[environment.machine]`). The
[configuration reference](configuration-reference.md) documents every field; to fill the stack
with data, add `resettable_volumes` and `seed` as
[Demo data, test users and roles](environment.md#demo-data-test-users-and-roles) describes.

## Bring the stack up

With Docker running, measure the runtime once with a local image, then start the stack, list its
services, run one command against it, and remove it:

```sh
docker pull node:22-alpine
./node_modules/.bin/cockpit runtime measure --config cockpit.toml --image node:22-alpine
./node_modules/.bin/cockpit up --config cockpit.toml
./node_modules/.bin/cockpit ps --config cockpit.toml
./node_modules/.bin/cockpit session --config cockpit.toml -- sh -c 'curl -fsS "http://127.0.0.1:$API_HOST_PORT/health"'
./node_modules/.bin/cockpit down --config cockpit.toml
```

`up` leases a free port family, so the api answers on the port it prints rather than always on
4200; `session` hands that port to its command as `API_HOST_PORT`. For everyday work, see
[Bring the product up](getting-started.md#bring-the-product-up) and
[Run an agent inside the environment](getting-started.md#run-an-agent-inside-the-environment).

## Clean up

Run `down` first if the stack is up, then delete the demo directory:

```sh
rm -rf "${TMPDIR:-/tmp}/cockpit-demo"
```
