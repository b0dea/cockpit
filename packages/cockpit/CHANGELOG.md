# @b0dea/cockpit

<!-- cockpit:verified version=0.0.0 -->

What changed in each release of cockpit, newest first, for someone deciding whether to upgrade:
what breaks, what to do about it, and what is new. Changesets writes each entry from the
changesets merged since the previous release. An entry that needs more than `cockpit sync` ends
with a line starting `Upgrade:`; the [changeset guide](../../.changeset/README.md) defines that
convention.

Versions follow [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The public surface a
major version protects is the CLI's commands and flags, the <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` schema, the generated
file layout, and the overlay contract. Deprecation and migration rules are in the
[release policy](../../docs/release-policy.md).

<!-- Changesets inserts each release above the first version heading, so this heading keeps the introduction above every release. -->

## 0.0.0

The development version. It was never published.
