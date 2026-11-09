---
"@b00dea/cockpit": patch
---

Sync binds the guard only to the cockpit installed under the cockpit root: run from any other copy, it refuses with `GENERATED_EXECUTABLE_UNAVAILABLE` and leaves the guard as it was. A root with no installed package, such as cockpit's own development checkout, keeps the module it is already bound to. The guard refuses `node <copy>/dist/cli.js sync` or `upgrade` from a copy of cockpit inside the roots, recognised by its package.json, and asks for any other command run from a copy.
