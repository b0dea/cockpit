# Releasing

<!-- cockpit:verified version=0.0.0 -->

This page is for the maintainer and contributors: how a change becomes a published release,
what is automated, and the manual steps the automation depends on.

## The release flow

Releases are automated with Changesets and GitHub Actions.

1. **A contributor adds a changeset** with `npx changeset` in the pull request that makes a
   user-visible change. CI requires one for pull requests touching the package source or shipped
   surfaces, unless the pull request carries the `no-changeset` label.
2. **Merging to main collects changesets.** The release workflow opens or updates a "Version
   Packages" pull request that applies the pending bumps, writes the entries into
   [packages/cockpit/CHANGELOG.md](../../packages/cockpit/CHANGELOG.md), and records the new
   version in `package-lock.json`.
3. **A maintainer starts CI on the Version Packages pull request** by closing and reopening it,
   as described in [Merging the Version Packages pull request](#merging-the-version-packages-pull-request).
4. **Merging the Version Packages pull request publishes.** The workflow publishes to npm through
   Trusted Publishing (OIDC, with provenance, no stored token), stamps the source commit into the
   package's `cockpitSourceRevision`, creates the GitHub release, and uploads the release record
   that `cockpit upgrade` reads.

After the [first publication](#first-publication), nobody runs `npm publish` by hand. A release
is a merge of the Version Packages pull request.

## Merging the Version Packages pull request

The release workflow opens that pull request with the workflow's own `GITHUB_TOKEN`, and GitHub
starts no workflow for an event that token causes. So CI never runs on it by itself, and the
required `ci-ok` check stays missing. Each later push to main rebuilds the pull request the same
way and leaves its newest commit unchecked again.

When you are ready to release:

1. Close the Version Packages pull request and reopen it. The reopen is your event, so CI runs on
   the current commit.
2. Review the version bump and the new changelog entry while CI runs.
3. Merge it once `ci-ok` passes. If main moves before you merge, the workflow rebuilds the pull
   request; close and reopen it again.

## First publication

npm Trusted Publishing cannot create a package: the
[npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust) require the package
to exist on the registry before a trusted publisher can be configured. Until then the release
workflow stops before publishing and names this section.

The bootstrap publishes a deprecated placeholder that contains no code, so the real first release
still goes through the workflow with provenance, a tag, a GitHub release and its release record.
Do it once, when the repository is public, the package manifest is no longer private, and the
Version Packages pull request is open but not merged:

1. Log in to npm with an account that owns the `b0dea` scope and has two-factor authentication,
   then publish and deprecate the placeholder from an empty directory:

   ```sh
   mkdir cockpit-bootstrap && cd cockpit-bootstrap
   printf '%s\n' '{"name": "@b0dea/cockpit", "version": "0.0.0-bootstrap.0", "license": "MIT", "description": "Reserves the package name. Install a release instead."}' > package.json
   printf '%s\n' '# @b0dea/cockpit' '' 'This version reserves the package name. Install a release instead.' > README.md
   npm publish --access public --tag bootstrap --provenance=false
   npm deprecate '@b0dea/cockpit@0.0.0-bootstrap.0' 'Reserves the package name. Install a release instead.'
   ```

   npm may point `latest` at the placeholder until the first release replaces it.
2. On npmjs.com, open the package's **Settings**, add a trusted publisher for GitHub Actions with
   organization or user `b0dea`, repository `cockpit`, workflow filename `release.yml`, and no
   environment. Allow it to publish with `npm publish`: the release workflow runs `npm publish`
   through Changesets, and a new trusted publisher allows only staged publishing by default.
3. Within two days, merge the Version Packages pull request as described above. An unused trusted
   publisher configuration expires after two days.
4. When the release run finishes, check that `npm view @b0dea/cockpit dist-tags` shows the new
   version as `latest`, and that the GitHub release has `release-evidence.json` attached.
5. Under the package's **Settings**, **Publishing access**, choose **Require two-factor
   authentication and disallow tokens**, so trusted publishing is the only way to publish.

If you merged the Version Packages pull request before the bootstrap, its release run failed
without publishing anything. Do steps 1 and 2, then re-run that run with
`gh run rerun <run-id> --repo b0dea/cockpit`.

## Dependency updates

Dependabot opens patch and minor update pull requests. They merge automatically once the `ci-ok`
check passes; major updates wait for review.

Some versions are pinned by a check, so their update cannot pass CI as Dependabot opens it. They
arrive together in the `pinned-by-hand` group, which auto-merge skips; the group's list is in
[.github/dependabot.yml](../../.github/dependabot.yml). Finish that pull request as described in
[Updating pinned dependencies](#updating-pinned-dependencies).

## Updating pinned dependencies

`rulesync` and `esbuild` produce the committed `packages/cockpit/libexec/rulesync-generator.cjs`
bundle and its legal notice, so a new version of either makes the bundle stale. The supply-chain
check pins the version of every installed package that has an install script or a binary, the
runtime dependencies, and the `allowScripts` entries. Each pin is there so a person reviews what
changed before it runs in CI or ships.

Check out the update's pull request, then regenerate and review:

```sh
gh pr checkout <number> --repo b0dea/cockpit
npm ci --ignore-scripts
npm run bundle:rulesync --workspace @b0dea/cockpit
npm run lint:supply-chain
```

When `lint:supply-chain` refuses, update the pins in `scripts/supply-chain-check.mjs` to the
versions now in `package-lock.json`: `REVIEWED_EXECUTABLE_LOCK_NODES` for
`LOCK_EXECUTABLE_POLICY_CHANGED` and `EXPECTED_RUNTIME_DEPENDENCIES` for
`RUNTIME_DEPENDENCIES_CHANGED`. For `ALLOW_SCRIPTS_POLICY_MISMATCH`, update `allowScripts` in the
root `package.json`. Read the changelog of each package whose pin you move. Then run the build,
`npm test` and `npm run typecheck`, commit the regenerated bundle and the pins, and push. Your
push starts CI; merge by hand once `ci-ok` passes.

## One-time setup

The automation above needs these settings, done once by the maintainer:

- **npm:** the [first publication](#first-publication), which also registers the release workflow
  as the package's trusted publisher.
- **Package:** remove `"private": true` from the package manifest and set `access` to `public` in
  the Changesets configuration.
- **GitHub:** allow auto-merge, allow GitHub Actions to create pull requests, require the `ci-ok`
  check on main, and create the `no-changeset` label. Once the repository is public, enable secret
  scanning with push protection and CodeQL default setup; the dependency-review job in CI starts
  running on its own.
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
