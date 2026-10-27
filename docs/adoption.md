# Adopting cockpit incrementally

<!-- cockpit:verified version=0.0.0 -->

This guide is for teams that already run a multi-repository product with their own scripts or
an earlier shell-registry cockpit, and want to move to cockpit one layer at a time without
breaking what works. Keep the old path runnable until the cockpit path has passed the same
checks.

## Describe the existing setup

If your current setup records its repositories in a shell registry, `document` turns it into an
attributed <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` draft. By default it reads the registry at
**env/lib/instance.sh** under the root you give it; pass `--registry` to name another file. A
directory without a registry is refused with `REGISTRY_NOT_FOUND`, so for a product with no
registry start from [Bootstrap a new product](getting-started.md#bootstrap-a-new-product)
instead.

```sh
cockpit document . --json
```

Every value the registry did not state is marked with its source and the reason it was
inferred or defaulted. This is real output for one of the repository's synthetic registry
fixtures, run from the cockpit checkout:

<!-- cockpit:capture date=2026-10-27 version=0.0.0 -->
```console
$ cockpit document --registry fixtures/registries/tier-dialect.sh
#:schema ./node_modules/@b0dea/cockpit/cockpit.schema.json
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

The draft deliberately fails validation until you resolve its gaps. In particular it reports
<!-- cockpit:ref schema=ports.bases --> `ports.bases` as unresolved when the registry does not carry the product's port map. Compare the
draft with the [configuration reference](configuration-reference.md), fill each gap, and never
substitute a similarly named registry found somewhere else.

## Bootstrap one harness

Pick one harness so the preview has a single publication boundary, preview, then accept:

```sh
cockpit init . --target codexcli --registry ./env/lib/instance.sh --json
cockpit init . --target codexcli --registry ./env/lib/instance.sh --interactive
```

The first command writes nothing. The second needs a terminal and the exact preview digest.
Accepted answers keep their source and provenance, and re-running the command resumes from the
stage it reached. When `init` observes repositories directly beneath the cockpit root instead
of reading a registry, it records `siblings_root = "."` as an inference for you to confirm.

## Adopt in layers

Move one layer at a time, and keep the previous layer's old path until the new one passes:

1. **Registry.** Get the reviewed configuration to validate.
2. **Generated environment and surfaces.** Run the
   [canonical bring-up sequence](getting-started.md#bring-the-product-up) up to `check`, and
   read the dry run before every `sync`.
3. **Runtime.** Run `up` and `preflight` against the same configuration.
4. **Guards, grading and more harnesses.** Add them once the earlier layers are stable. The
   [capability matrix](capability-matrix.md) shows each harness feature's
   [Cockpit harness capability state](concepts.md#cockpit-harness-capability-state); an
   `instructed` feature should not yet replace a legacy control that is enforced.

Two ordering rules matter during the generated-environment layer:

- **Generated vendor templates come first.** When cockpit generates a sibling's environment
  template, prepare the sibling checkouts, run `sync`, then review and commit the template in its
  own repository before `setup` creates the ignored instance from it. The
  [tutorial](tutorial.md#apply-the-sync-and-set-up) shows this order.
- **cockpit never takes over an unmanaged file.** If a file already exists where cockpit wants to
  generate one, `sync` refuses. Keep the existing file, review the destination and the ownership
  change, and move it deliberately.

Before adopting environment credentials, let `sync` create the ignore boundary and follow
[Secret sources and environment schemas](environment.md#secret-sources-and-environment-schemas).
[Cockpit generated ownership](concepts.md#cockpit-generated-ownership) protects cockpit's own
output; it never authorises removing a file cockpit did not write.

## Complete the cutover

Retire the old path only when every responsibility it had passes under cockpit (`check`, `up`
and `preflight` for the same configuration and runtime) and you know how to roll back.
Destructive environment commands, stale-output removal, changes to external services and
publication stay explicit human decisions. To compare the two paths side by side first, see
[Environment comparison](parallel-run.md). For recovery, see [Environment](environment.md) and
[Troubleshooting](troubleshooting.md).
