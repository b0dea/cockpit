---
'@b00dea/cockpit': patch
---

After a merge, an agent can bring a stale local protected branch up to date with `git fetch origin main:main`, which only fast-forwards it from a configured remote's own copy, and then switch to it. A refused switch to a stale protected branch now says so. A fetch whose pattern destination such as `refs/heads/*` reaches a protected branch is refused. A fetch that takes refspecs from `--refmap` or `--stdin` now asks, and so do `git remote add`, `set-url`, `rename` and `set-branches`. Running cockpit in the same call as a shell form the guard does not read is still refused, and the refusal now names that form. After a successful approve under Safe Chain, approve says that Safe Chain's "Some package versions were suppressed" notice is not a failure.
