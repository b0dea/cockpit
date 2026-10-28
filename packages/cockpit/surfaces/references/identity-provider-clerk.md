# Identity provider starter: Clerk

<!-- cockpit:verified version=0.0.0 -->

Read this only when the consumer's lockfile shows Clerk together with `@clerk/testing` and
`@playwright/test`. It adds provider specifics to the procedure in `test-data-and-personas.md`; the rules
there still apply. Any other provider needs its own starter, so stop and ask rather than adapting this one.

## Confirm roles before using them

**What.** Check that the Clerk instance exposes each role you assign.
**Why.** `org:admin` and `org:member` are only starter candidates. Custom roles, Role Sets and permissions come
from the instance and the product's authorization model, and system permissions are not session claims, so an
assumed role signs in and then fails authorization for a reason that looks like a product bug.
**How.** Read the roles from the instance and the product's authorization code, never from this page.

## Create the identities

The consumer adapter creates or adopts the stable synthetic users and organization and uses direct
memberships with confirmed roles. Secrets cross only its existing secret-bearing command.

## Sign in and save state

In a serial project-based Playwright setup, call `clerkSetup()`. For each persona, navigate to an unprotected
page that loads Clerk, call `clerk.signIn({ page, emailAddress })`, verify authorization, and write the
declared state. `clerk.signIn` supplies its own testing-token step, so do not add a second token helper
around it: a duplicate helper hides which one failed.

Current references: [Clerk Playwright setup](https://clerk.com/docs/guides/development/testing/playwright/overview),
[Clerk sign-in helper](https://clerk.com/docs/guides/development/testing/playwright/test-helpers),
[Clerk roles and permissions](https://clerk.com/docs/guides/organizations/control-access/roles-and-permissions)
and [Playwright authentication](https://playwright.dev/docs/auth).
