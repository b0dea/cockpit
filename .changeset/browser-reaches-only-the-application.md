---
"@b00dea/cockpit": patch
---

Browser operations reach only what they should.

- Browser operations block requests to loopback and resolver-mapped hosts outside the application origin. Redirects that the browser follows are not routed, so they are not blocked.
- `up` and `sync` name an unparseable browser project `package.json` or lockfile with the line and column, and no longer quote its contents.
