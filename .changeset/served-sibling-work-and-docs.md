---
"@b00dea/cockpit": patch
---

Work orders and `docs check` read a sibling where `cockpit use` serves it. Heads, changes, test-weakening detection, grades, test gates and `docs check` used the checkout cockpit.toml declares even while the stack ran a worktree, so a grade could pass work it never saw; they now read the served checkout, and refuse with `SIBLING_CHECKOUT_UNAVAILABLE` when that checkout is gone.

`work decide --supersedes` reads decision records as `docs check` does. It marks a record whose status is a `- Status:` or `__Status__:` line, the line under a `## Status` heading, or CRLF front matter, rewriting it in place, and it no longer rewrites a `Status:` line inside a code fence. A record named `0012_x.md` is numbered 12 when choosing the next record's number.
