# Releasing

<!-- cockpit:verified version=0.0.0 -->

This page is for the maintainer and contributors: how a change becomes a published release,
what is automated, and the one-time setup the automation depends on.

## The release flow

Releases are automated with Changesets and GitHub Actions.

1. **A contributor adds a changeset** with `npx changeset` in the pull request that makes a
   user-visible change. CI requires one for pull requests touching the package source or shipped
   surfaces, unless the pull request carries the `no-changeset` label.
2. **Merging to main collects changesets.** The release workflow opens or updates a "Version
   Packages" pull request that applies the pending bumps and changelog entries.
3. **Merging the Version Packages pull request publishes.** The workflow publishes to npm through
   Trusted Publishing (OIDC, with provenance, no stored token), stamps the source commit into the
   package's `cockpitSourceRevision`, and creates the GitHub release.

Nobody runs `npm publish` by hand. A release is a merge of the Version Packages pull request.

## Dependency updates

Dependabot opens patch and minor update pull requests. They merge automatically once the `ci-ok`
check passes; major updates wait for review.

## One-time setup

The automation above needs these settings, done once by the maintainer:

- **npm:** register the repository's release workflow as a trusted publisher for the package.
- **Package:** remove `"private": true` from the package manifest and set `access` to `public` in
  the Changesets configuration.
- **GitHub:** allow auto-merge, require the `ci-ok` check on main, and create the `no-changeset`
  label.
- **Reporting channels:** enable private vulnerability reporting, then change the
  `private-reporting-channel` marker in [SECURITY.md](../../SECURITY.md) from `pending` together
  with the ownership test that pins it. Publish a private conduct contact in
  [CODE_OF_CONDUCT.md](../../CODE_OF_CONDUCT.md#enforcement).

## Before the repository goes public

Repository visibility and package publication are separate decisions, and a green test run
does not decide either. Before opening the repository, run every gate in a maintainer checkout that
has the private needle file, so the site-name class is scanned too:

```sh
npm run build
npm test
npm run typecheck
npm run lint:docs
npm run lint:supply-chain
node scripts/hygiene-scan.mjs --history
npm audit --ignore-scripts
```

The working tree, the package tarball and the reachable history are scanned separately. A
history report with findings, binary gaps or exceeded limits is not clean. If old history
contains private material, publish a fresh root from the scanned source export instead of the
old Git directory, branches or tags, and keep the private repository until you decide what to
do with it.

After the first publication, install the package from npm on a clean machine, run the
[synthetic example](../../examples/synthetic/README.md), and read back the
public repository. Before claiming cockpit generalises, use it for real on at least three
differently shaped products: two established setups and one new one.
