# Changesets

<!-- cockpit:verified version=0.0.0 -->

This directory holds pending release notes. Contributors add one with each user-visible change;
the release workflow turns them into a version bump and changelog entry.

Run `npx changeset`, pick the bump (patch, minor or major), and write the entry for someone
deciding whether to upgrade: what changed, what breaks, and what to do about it. Commit the
generated file with your change.

A pull request that touches the package's source or shipped surfaces needs a changeset unless it
carries the `no-changeset` label. The release flow is described in
[Releasing](../docs/contributing/releasing.md).
