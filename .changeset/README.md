# Changesets

<!-- cockpit:verified version=0.0.0 -->

This directory holds pending release notes. Contributors add one with each user-visible change;
the release workflow turns them into a version bump and changelog entry.

Run `npx changeset`, pick the bump (patch, minor or major), and write the entry for someone
deciding whether to upgrade: what changed, what breaks, and what to do about it. Commit the
generated file with your change.

When a cockpit that upgrades needs more than `cockpit sync`, end the entry with one line starting
`Upgrade:` that names the step, for example `Upgrade: rename [guards] hosts to hosted_db_hosts,
then run cockpit sync`. People and agents upgrading read the changelog between their old and new
version for exactly those lines, so an entry without one promises that sync alone is enough.

A pull request that touches the package's source or shipped surfaces needs a changeset unless it
carries the `no-changeset` label. The release flow is described in
[Releasing](../docs/contributing/releasing.md).
