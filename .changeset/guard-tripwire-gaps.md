---
"@b00dea/cockpit": patch
---

The guard refuses three more ways of reaching a secret:
- A recursive search that would read a secret is refused when a wrapper or shell string runs it, as in `timeout 30 grep -rn KEY local/` or `sh -c "grep -rn KEY local/"`, as it already was when run bare.
- A glob in any path component, not only the last, is refused when it can match a protected name: `cat .se*/creds.json` reads inside `.secrets`.
- A secret path glued to a group of short options, as in `base64 -di.env`, is refused.

Upgrading from 0.1.23 or earlier: since 0.1.24 a declared `[[guards.deny]]` matches its program under any case, so a stopgap deny such as `prefix = ["GIT"]` refuses every `git` command. Remove case-variant denies, then run `cockpit sync` in a terminal.
