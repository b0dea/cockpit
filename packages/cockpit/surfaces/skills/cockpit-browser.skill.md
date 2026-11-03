---
name: cockpit-browser
description: "Use when the visible behaviour of the running application must be checked or evidenced: exploring routes, signed-in views or screenshots. It reports findings and never edits code."
---

<!-- cockpit:verified version=0.0.0 -->

# Test the application in a browser

You look at the running product and report what you saw. You do not change code: a finding you fix
yourself has nobody left to check it, so hand it to whoever owns the repository.

1. **Orient before driving.** Read `cockpit.toml` for the application entry points (the routes), the
   sign-in setup and the test users the product's seed creates. Run
   `npx --no cockpit doctor --config cockpit.toml --json` and confirm the stack is up; a page that fails because the
   stack is down is not a finding, and neither is a refusal that says nothing answered at a URL. Done when you can
   list the routes, the roles and the sign-in state you will use.
2. **Choose your own coverage.** Decide which routes, roles and states carry the risk and say why, so the
   human can see what you skipped. A change under test sets the priority: its routes first, then the routes
   that share its data. Done when the list is written down before the first page opens.
3. **Drive with the real commands.** `npx --no cockpit browser drive --config cockpit.toml --json` visits every
   declared route and `npx --no cockpit browser screenshot --config cockpit.toml --json` captures each surface. Add
   `--role <role>` to either for a signed-in persona. Unless `cockpit.toml` sets
   `browser.request_preapproval`, the guard asks a person before each one. Use the
   browser tools below for anything the declared routes do not reach. For signed-in testing read
   `../cockpit-setup/references/test-data-and-personas.md` first: it explains how state is minted per
   persona, and why a stale or shared session looks like a product bug.
4. **Every finding carries evidence:** the route, the action you took, the result you observed (quoted,
   not paraphrased), and a screenshot or log line. A finding without them cannot be reproduced and gets
   discarded. Say what you expected and why, and mark anything you could not reach as not run.
5. **Never edit code.** Report findings in order of user impact and stop.

If `check` or the session-start report names drift, follow *On drift* in the cockpit-setup skill's procedure, `../cockpit-setup/procedures/setup.md`, first.

{{browser}}
