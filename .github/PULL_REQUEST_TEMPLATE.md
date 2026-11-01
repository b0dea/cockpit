## What this changes, and why

<!-- cockpit:verified version=0.0.0 -->

<!-- What is now true that was not before, and the failure that motivated it. The diff already
says what moved; this says why it had to. -->

## How it was verified

<!-- The commands you ran and their real output, not a summary. Say which parts you verified
and which you believe but did not run — that distinction is the useful half. -->

## Checklist

Every line here is something that has gone wrong before. Strike out anything that genuinely
does not apply, with the reason.

- [ ] `npm test`, `npm run typecheck`, `npm run lint:docs` and `npm run lint:supply-chain` pass
      locally, and their output is pasted above.
- [ ] A bug fix comes with a test that **fails without the change** — I saw it fail.
- [ ] No consumer-identifying material: no client or employer names, no private hostnames, no
      real registries, no credentials, no internal URLs — including in the commit messages,
      which cannot be corrected later without a rewrite.
- [ ] Fixtures are synthetic and exercise the same shape as the real thing.
- [ ] Documentation for a behaviour change is in this pull request, not a follow-up.
- [ ] A changeset (`npx changeset`) describes any change visible to someone using cockpit, or
      nothing a consumer sees changed and you have asked a maintainer to add the `no-changeset`
      label.
- [ ] Nothing here reads as a control while binding nothing: no configuration that parses and
      does nothing, no CI step that runs nothing, no claim of enforcement without the thing
      that enforces it.
- [ ] Any harness capability claim was **measured by probing the tool** with a broken control
      file alongside, and is dated — not read from documentation.
- [ ] Shipped templates under `packages/cockpit/surfaces/` contain no repository-maintenance
      instructions.
- [ ] A new dependency is exactly pinned, in the lockfile, and argued for in the description.
- [ ] Anything that needs a human decision, a destructive action, an external service, a native
      harness run or publication is listed as not verified, rather than reported done.

## Related issues

<!-- Schema, generated file layout, overlay contract or CLI surface changes should have an
issue agreeing the shape first. Link it. -->
