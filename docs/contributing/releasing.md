# Releasing

This page is for the maintainer: how a change becomes a published release, what is automated, and
the manual steps the automation depends on.

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
4. **Merging the Version Packages pull request publishes.** The workflow's `publish` job
   publishes to npm through Trusted Publishing (OIDC, with provenance, no stored token), stamps
   the source commit into the package's `cockpitSourceRevision`, and creates the GitHub release.
   Only that job runs in the `npm`
   deployment environment the trusted publisher names, so no other job or branch can publish.

After the [first publication](#first-publication), nobody runs `npm publish` by hand.

## Merging the Version Packages pull request

The release workflow opens that pull request with its own `GITHUB_TOKEN`, and GitHub starts no
workflow for an event that token causes. CI never runs on it by itself, so the required `ci-ok`
check stays missing, and each later push to main leaves the newest commit unchecked again.

When you are ready to release:

1. Close the Version Packages pull request and reopen it. The reopen is your event, so CI runs on
   the current commit.
2. Review the version bump and the new changelog entry while CI runs.
3. Merge it once `ci-ok` passes. If main moves before you merge, the workflow rebuilds the pull
   request; close and reopen it again.

`ci-ok` includes the `version pull request scope` check, which fails when the pull request
changes anything besides version fields in `package.json` and `package-lock.json`, `CHANGELOG.md`
files and consumed `.changeset/*.md` files. It exists so a commit pushed onto the version branch
cannot ship hidden inside the bump. If it fails, the error names each file outside that scope:
remove those commits from the branch, or let the workflow rebuild it with the next push to main.

## First publication

npm Trusted Publishing cannot create a package: the
[npm trust prerequisites](https://docs.npmjs.com/cli/v11/commands/npm-trust) require the package
to exist on the registry before a trusted publisher can be configured. Until then the release
workflow stops before publishing and names this section.

The bootstrap publishes a deprecated placeholder that contains no code, so the real first release
still goes through the workflow with provenance, a tag and a GitHub release.
Do it once, when the repository is public, the package manifest is no longer private, and the
Version Packages pull request is open but not merged:

1. Log in to npm with an account that owns the `b00dea` scope and has two-factor authentication,
   then publish and deprecate the placeholder from an empty directory:

   ```sh
   mkdir cockpit-bootstrap && cd cockpit-bootstrap
   printf '%s\n' '{"name": "@b00dea/cockpit", "version": "0.0.0-bootstrap.0", "license": "MIT", "description": "Reserves the package name. Install a release instead."}' > package.json
   printf '%s\n' '# @b00dea/cockpit' '' 'This version reserves the package name. Install a release instead.' > README.md
   npm publish --access public --tag bootstrap --provenance=false
   npm deprecate '@b00dea/cockpit@0.0.0-bootstrap.0' 'Reserves the package name. Install a release instead.'
   ```

   npm may point `latest` at the placeholder until the first release replaces it.
2. Create the `npm` deployment environment, limited to the `main` branch, then name it in the
   trusted publisher. Create the environment in the repository's **Settings**, **Environments**,
   with **Deployment branches and tags** set to `main` only, or with:

   ```sh
   printf '%s' '{"deployment_branch_policy":{"protected_branches":false,"custom_branch_policies":true}}' \
     | gh api -X PUT repos/b0dea/cockpit/environments/npm --input -
   gh api -X POST repos/b0dea/cockpit/environments/npm/deployment-branch-policies -f name=main -f type=branch
   ```

   On npmjs.com, open the package's **Settings**, add a trusted publisher for GitHub Actions with
   organization or user `b0dea`, repository `cockpit`, workflow filename `release.yml`, and
   environment `npm`. Allow it to publish with `npm publish`: the release workflow runs
   `npm publish` through Changesets, and a new trusted publisher allows only staged publishing by
   default.
3. Within two days, merge the Version Packages pull request as described above. An unused trusted
   publisher configuration expires after two days.
4. When the release run finishes, check that `npm view @b00dea/cockpit dist-tags` shows the new
   version as `latest`, and that the GitHub release exists.
5. Under the package's **Settings**, **Publishing access**, choose **Require two-factor
   authentication and disallow tokens**, so trusted publishing is the only way to publish.

If you merged the Version Packages pull request before the bootstrap, its release run failed
without publishing anything. Do steps 1 and 2, then re-run that run with
`gh run rerun <run-id> --repo b0dea/cockpit`.

## Dependency updates

Dependabot opens patch and minor update pull requests. They merge automatically once the `ci-ok`
check passes; major updates wait for review. A new npm release is offered only after a cooldown that grows with its semver level, so a hijacked
publish is usually pulled before it reaches the lockfile; see
[.github/dependabot.yml](../../.github/dependabot.yml).

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
npm run bundle:rulesync --workspace @b00dea/cockpit
npm run lint:supply-chain
```

When `lint:supply-chain` refuses, update the pins in `scripts/supply-chain-check.ts` to the
versions now in `package-lock.json`: `REVIEWED_EXECUTABLE_LOCK_NODES` for
`LOCK_EXECUTABLE_POLICY_CHANGED` and `EXPECTED_RUNTIME_DEPENDENCIES` for
`RUNTIME_DEPENDENCIES_CHANGED`. For `ALLOW_SCRIPTS_POLICY_MISMATCH`, update `allowScripts` in the
root `package.json`. Read the changelog of each package whose pin you move. Then run the build,
`npm test` and `npm run typecheck`, commit the regenerated bundle and the pins, and push. Your
push starts CI; merge by hand once `ci-ok` passes.

## One-time setup

The automation above needs these settings, done once by the maintainer:

- **npm:** the [first publication](#first-publication), which also creates the `npm` deployment
  environment and registers the release workflow in it as the package's trusted publisher.
- **Package:** remove `"private": true` from the package manifest and set `access` to `public` in
  the Changesets configuration.
- **Pre-publication wording:** in the same change, rewrite every statement that the package is not
  yet published or that sends readers to the source install first: `README.md`, `llms.txt`,
  `docs/tutorial.md`, `docs/getting-started.md`, `examples/synthetic/README.md` and the adopt skill
  source `scripts/adopt-cockpit.skill.md`, then run `npm run references`.
  `docs-ownership.test.ts` fails while this list misses a file with such wording, and fails on any
  that remains once the package is public.
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
npm run lint:markdown
npm run lint:links
npm run lint:supply-chain
node scripts/hygiene-scan.ts --history
npm audit --ignore-scripts
```

The working tree, the package tarball and the reachable history are scanned separately. A history
report with findings, binary gaps or exceeded limits is not clean. If old history contains private
material, publish a fresh root from the scanned source export instead of the old Git directory,
branches or tags.

After the first publication, install the package from npm on a clean machine and run the
[synthetic example](../../examples/synthetic/README.md).
