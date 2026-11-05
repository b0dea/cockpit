---
'@b00dea/cockpit': patch
---

Protect `.secrets` directories at any depth, and make the tracked-secret check agree with the guard: `.env.schema` is no longer reported, while `.env.dist` and tracked files below a `.secrets` directory are, and a declared environment template stays exempt.

**Migration:** the generated ignore block now covers `.secrets` contents everywhere, so existing cockpits report it as drift until the next `sync`. The guard now denies `git add` of a directory, or `git add .` in a managed repository, whose tree holds a `.secrets` directory, where it used to ask. Stage explicit paths instead. A `.env.dist` that holds no secrets can be declared as an environment template to clear the new report.
