# Test data, test users and signed-in browser state

<!-- cockpit:verified version=0.0.0 -->

Use this when authentication changes what the product does and an agent needs seeded test users, or
signed-in browser state for them. It is a product change, so it needs explicit permission to edit
the product's fixtures and auth setup. The cockpit-setup skill loads it, and so does cockpit-browser
before signed-in testing. The declaration side (modes, personas, fixture hygiene) is described in
the *Demo data, test users and roles* section of `./node_modules/@b0dea/cockpit/docs/environment.md`;
this page is the procedure an agent follows against a real product and does not repeat it.

## Find what already exists

**What.** Inspect the consumer's package manifests and lockfiles, product models, fixture source, seed
commands and probes, auth setup, ignore rules and authorization tests. Extend those instead of adding new ones.
**Why.** A second seeder or a guessed library version disagrees with the product's own writers, and the
disagreement shows up later as failures that look like product bugs.
**How.** Resolve test-library versions from the consumer lockfile. Never make up a version,
provider setting, custom role or permission. Read the roles the identity provider's instance exposes and
the product's authorization code before assigning one: a role that looks standard may not exist there, and
an assumed role signs in and then fails authorization for a reason that looks like a product bug.

## Declare personas

**What.** Create or extend the product-owned persona source with stable synthetic IDs such as
`auth-admin` and `auth-member`. Give each a stable external key, a non-secret test identifier, the expected
product row, a provider identity reference, a confirmed role, and one permitted and one denied operation.
**Why.** Stable IDs let a re-seed update rows instead of duplicating them, and the permitted and denied
pair proves the roles work, not only that sign-in succeeded.
**How.** Credentials, provider keys and browser state stay outside the fixture. The product's own seeder
writes product rows; the existing provider adapter writes provider users, organizations and memberships. Bind
their idempotent commands to the existing seeded operations and probes. When an adapter is genuinely absent,
add a thin consumer-owned adapter behind the seed command.

Before any seed write, assert that its database and service targets are local. Resolve paths into a sibling by
probing the declared sibling root and then the consumer's documented fallback; never encode one checkout layout
as a constant. Seed twice and report every restore gap, because idempotence and omissions are otherwise invisible.

## Touch the identity provider safely

**What.** Provider writes create or adopt the synthetic users, organization and memberships.
**Why.** Provider objects can be shared with people, and a write you cannot take back is a customer's problem.
**How.**

- Permission to edit product fixtures is not permission to change the provider. Limit your changes to one named
  development instance and the exact synthetic users, organization and memberships in scope. If the human has
  not already approved that exact scope, preview the mutations and ask.
- Adopt only provider objects that carry the synthetic ownership marker. Refuse any other and name the
  account in the refusal.
- Never rewrite the roles of a shared identity.
- Cleanup removes only those same synthetic resources, preserves unrelated identities and records
  the result.
- A local stack receives no webhooks from the provider, so link the provider ID to the product row explicitly.
- Spend a seeded credential once before claiming success; a placeholder passes every read-only check.

## Mint browser state

**What.** One state file per persona, saved after a real sign-in.
**Why.** A session reused across workers or after a reseed goes stale and fails in ways that look like
product defects.
**How.**

1. Warm the application first, then wait for the provider session to exist before saving state. Done when a
   signed-in page has rendered.
2. Mint serially from a clean context under the declared ignored auth root: directory mode 0700, files 0600,
   one state per persona, using the consumer's own Playwright package. Sign in through the identity
   provider's own testing helper when it ships one, and do not wrap it in a second token helper: a
   duplicate hides which one failed.
3. Verify the active synthetic identity, organization, role and application permission before saving.
4. Re-mint after any reseed or reset. Name files so the reset patterns match them; a file outside those
   patterns survives a reset. Replay every wipe pattern against a synthetic fixture before relying on it.
5. If the page raises a navigation-during-evaluate error, retry that one error, with a bound (a few attempts).
   Retrying anything else hides real failures.
6. Run one permitted and one denied authorization behavior through the product surface. Reset the task's
   auth and browser artifacts through cockpit and read back their absence while preserving unowned state.

## Report what you proved

Report each layer on its own as PASS, FAIL or NOT_RUN: source inspection, the synthetic provider
boundary and the live provider. Reusing existing state proves only that cockpit can use those bytes; a
synthetic provider proves only that the pieces connect. Report the live provider as NOT_RUN until a probe that a person approved,
with secrets masked, against the named development instance has created or adopted only the scoped
identities, seeded twice, minted every state, checked both authorization outcomes, cleaned only those
resources and recorded the result. Keep provider SDKs in the consumer, not in cockpit.
