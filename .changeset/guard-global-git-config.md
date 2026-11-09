---
"@b00dea/cockpit": patch
---

The guard's own Git queries now read your global Git configuration, from `HOME` and `XDG_CONFIG_HOME` as your Git does, so a `push.default = matching`, a `pull.rebase = true` or a credentialed `insteadOf` set only there is judged: a matching push or a rebasing pull on a protected branch is refused, and `git remote -v` with such a rewrite is refused. Agents cannot write that configuration, since it lies outside the cockpit.
