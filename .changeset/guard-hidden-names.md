---
"@b00dea/cockpit": patch
---

Under the allow default, an argument holding a command substitution, or a variable this call set to one or to a path outside the cockpit, asks for any program but `echo` and `printf`, and `curl` or `wget` with any expansion asks. A path that climbs out of the cockpit with `..` anywhere in it follows `[guards] external_reads` like an absolute one. `for f in src/*.ts; do wc -l "$f"; done` is allowed when every item is visible inside the cockpit and the body reads each as a read-only command would. `rimraf`, `del-cli` and `trash` are judged as removers, and `corepack` asks, because the guard does not follow the program it runs.
