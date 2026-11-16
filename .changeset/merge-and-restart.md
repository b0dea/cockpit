---
"@b00dea/cockpit": patch
---

Two stops on ordinary work are gone.

**Fixed:** `git merge` is judged by what the other branch changed since the common ancestor, so merging main into a branch that retired a hook or setting main still carries, unchanged, is no longer refused. A merge that brings a changed guard control or agent setting is still refused. `up` starts a stack again when its containers stopped outside cockpit, as after a machine sleeps, instead of asking you to run `sleep` first; this applies when the stack's progress is this checkout's and no other session holds it.
