<!-- cockpit:verified version=0.0.0 -->

## What changed, and why

<!-- What is now true, and the failure that motivated it. Link the issue if the change touches the
config schema, generated file layout, overlay contract or a CLI command or flag. -->

## How it was verified

<!-- Commands you ran and their real output. Say what you did not run. -->

## Checklist

- [ ] A bug fix has a test that fails without it.
- [ ] `npm test`, `npm run typecheck`, `npm run lint:docs` and `npm run lint:supply-chain` pass.
- [ ] A change a cockpit user can see has a changeset (`npx changeset`); otherwise ask for the `no-changeset` label.
- [ ] A commit that deletes or weakens a test carries a `COCKPIT_TEST_WEAKENING_ACK:` line.
- [ ] Nothing consumer-identifying, including in commit messages.
