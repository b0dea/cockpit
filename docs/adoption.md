# Adopting cockpit incrementally

<!-- cockpit:verified version=0.0.0 -->

This guide is for teams that already run a multi-repository product with their own scripts or a
shell-registry cockpit, and want to move to cockpit one layer at a time. Keep the old path
runnable until the cockpit path passes the same checks.

## Describe the existing setup

If your setup records its repositories in a shell registry, `document` turns it into an attributed
<!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` draft. It reads **env/lib/instance.sh** under the root you give it, or
the file named by `--registry`. A directory without one is refused with `REGISTRY_NOT_FOUND`; for a
product with no registry, start from [Getting started](getting-started.md#choose-a-starting-point).

```sh
./node_modules/.bin/cockpit document . --json
```

Every value the registry did not state is marked with its source and the reason it was inferred
or defaulted. Output for one of this repository's synthetic registry fixtures:

<!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
```console
$ cockpit document --registry fixtures/registries/tier-dialect.sh
#:schema ./node_modules/@b00dea/cockpit/cockpit.schema.json
# COCKPIT DOCUMENT: INCOMPLETE DRAFT — this file intentionally fails validation.
# Provenance — every unread value names its source and reason.
# [default] cockpit.siblings_root = "..": the registry dialect does not record the sibling checkout root; materialised from the CockpitConfig schema default
...
# [inferred] sibling.app.mount = "always": tier "required" — the stack bind-mounts it or preflight fails
# [inferred] sibling.app.acquire = "auto": tier "required" implies setup clones it
...
# [inferred] sibling.docs.mount = "host": purpose opens with `make screenshots` — a target, never a compose service
...
```

The draft deliberately fails validation until you fill its gaps, for example
<!-- cockpit:ref schema=ports.bases --> `ports.bases` when the registry does not carry the port map. Fill each from the
[configuration reference](configuration-reference.md), and never substitute a similarly named
registry found elsewhere.

## Bootstrap one harness

Preview for one harness, then accept. Replace `<tool>` with its target, listed under
[Bootstrap a new product](getting-started.md#bootstrap-a-new-product):

```sh
./node_modules/.bin/cockpit init . --target <tool> --registry ./env/lib/instance.sh --json
./node_modules/.bin/cockpit init . --target <tool> --registry ./env/lib/instance.sh --interactive
```

The first command writes nothing; the second needs a terminal and the exact preview digest.
Accepted answers keep their source, and re-running resumes where it stopped. When `init` finds
repositories directly beneath the cockpit root instead of reading a registry, it records
`siblings_root = "."` as an inference for you to confirm.

## Adopt in layers

Keep each layer's old path until the new one passes:

1. **Registry.** Get the reviewed configuration to validate.
2. **Generated environment and surfaces.** Run the
   [canonical bring-up sequence](getting-started.md#bring-the-product-up) up to `check`, and
   read the dry run before every `sync`.
3. **Runtime.** Run `up` and `preflight` against the same configuration.
4. **Guards, grading and more harnesses.** Add them once the earlier layers are stable. The
   [capability matrix](capability-matrix.md) shows each harness feature's
   [Cockpit harness capability state](concepts.md#cockpit-harness-capability-state); an
   `instructed` feature should not yet replace a legacy control that is enforced.

Three rules matter in the generated-environment layer:

- **Generated environment templates come first.** When cockpit generates a sibling's environment
  template, put the sibling checkouts in place and run `sync`, then review and commit the template
  in its own repository before `setup` creates the ignored instance from it. The [tutorial](tutorial.md#apply-the-sync-and-set-up)
  shows this order.
- **cockpit never takes over an unmanaged file.** If a file already exists where cockpit wants to
  generate one, `sync` refuses; move the existing file deliberately. The one supported exception
  is a team's agent settings file, which you can [adopt](#adopt-existing-agent-settings).
  [Cockpit generated ownership](concepts.md#cockpit-generated-ownership) covers only cockpit's own
  output and never permits removing a file cockpit did not write.
- **Secrets after the ignore boundary.** Let `sync` create the ignore boundary before adopting
  environment credentials, then follow
  [Secret sources and environment schemas](environment.md#secret-sources-and-environment-schemas).

## Keep shell scripts on the registry while you migrate

While old scripts still read the shell registry, `registry-resolve` validates it and prints the
same rows as data a script can `source`, so the scripts and cockpit read one checked copy. It
takes three required flags:

```sh
./node_modules/.bin/cockpit registry-resolve \
  --registry ./env/lib/instance.sh --siblings-root .. --adoption ./adoption.state > resolved.sh
```

`--adoption` names a five-line file that records how far each layer has moved to cockpit. The
lines name the layers in this order, each set to `migrated` or `documented-only`, and the migrated
layers come first:

```text
registry=migrated
environment=documented-only
surfaces=documented-only
guards=documented-only
grading=documented-only
```

The output assigns `COCKPIT_REGISTRY_ROWS`, `COCKPIT_SIBLING_PATHS`, `COCKPIT_SIBLING_VARIABLES`
and `COCKPIT_ADOPTION_STATES`, exports one `*_DIR` variable per sibling, and records the registry
digest in `COCKPIT_REGISTRY_SHA256`. `COCKPIT_SOURCE_REVISION` is the cockpit commit that produced
the data. A cockpit installed from a tarball packed from source has no release commit, so the
value is `development` and the command warns with `COCKPIT_REVISION_UNSTAMPED`. Nothing is printed
unless every input passed validation.

## Adopt existing agent settings

For a repository that already commits its own `.claude/settings.json`, `.codex/config.toml` or
`.codex/hooks.json`. cockpit writes those files whole, so a plain `sync` refuses with
`SURFACE_STATE_CONFLICT` and names the command that keeps the team's settings:

```sh
./node_modules/.bin/cockpit sync --config cockpit.toml
./node_modules/.bin/cockpit sync --config cockpit.toml --adopt .claude/settings.json
./node_modules/.bin/cockpit check --config cockpit.toml
```

`--adopt <path>` can be repeated, once per file. It moves the file to `cockpit/adopted/<path>`,
records a <!-- cockpit:ref schema=surfaces.adopted --> `surfaces.adopted` row in cockpit.toml (path, source, SHA-256 of the moved bytes, date,
provenance), and syncs. The file at `<path>` becomes cockpit's merge of the adopted copy and its
own generated version:

- **Hooks:** the team's hooks are kept beside cockpit's guard hook. `PreToolUse` entries are
  combined; any other hook event both sides define must be identical.
- **Claude permissions:** `allow`, `ask` and `deny` rules are combined. A rule cockpit denies is
  never kept as a team `allow` or `ask`.
- **Every other key** is the team's, unless cockpit writes the same key; then the two values must
  match.

Commit `cockpit/adopted/` with cockpit.toml: it is the team's copy and, from now on, the place to
change those settings. To change them, edit the adopted copy, delete the merged file and run
`sync`; `check` reports a hand-edited merged file, or an adopted copy changed since the last
merge, and `sync` refuses the former. The recorded SHA-256 says which bytes were moved; it is not
a lock.

Adoption is refused with `SURFACE_ADOPTION_REFUSED`, naming the key, when the file would switch off
or route around the guard, or carries a setting cockpit declares elsewhere:

- `disableAllHooks`, `permissions.defaultMode = "bypassPermissions"`, or any hook that names a
  `.cockpit/guards/` transport;
- `permissions.additionalDirectories` and `enabledMcpjsonServers` (declare a sibling or approve
  the MCP server instead);
- in `.codex/config.toml`, `mcp_servers` and `features.codex_hooks = false`.

Adoption reads and moves only regular files inside the cockpit root, so it also refuses redirected
ancestors, links, special files and files that change while being read; replace them with plain
files and re-run. A refusal is rolled back, leaving the file in place and cockpit.toml unchanged. If
a concurrent replacement prevents a safe rollback, the refusal names every private recovery path
that may still hold the original bytes, with their SHA-256; keep those paths until the source is
restored. Because adoption changes cockpit.toml, it has no dry run or `--interactive` form, and an
agent's guard never treats it as an ordinary command.

`opencode.jsonc` needs no adoption: cockpit writes only its `$schema`, `instructions`, `mcp` and
`permission` keys and keeps the team's other keys as they are.

## Complete the cutover

Retire the old path only when everything it did passes under cockpit (`check`, `up` and
`preflight` for the same configuration and runtime) and you know how to roll back. Destructive
environment commands, stale-output removal, changes to external services and publication stay
explicit human decisions. For recovery, see [Environment](environment.md) and
[Troubleshooting](troubleshooting.md).
