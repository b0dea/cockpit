---
"@b00dea/cockpit": patch
---

Protect `.secrets` directories at any depth when staging: the generated ignore block now covers their contents everywhere, and the guard denies `git add` of a directory, or `git add .` in any managed repository, whose tree holds one. Docs and the setup procedure now describe that generated block in place of an `env/.secrets/.gitignore` nothing generates. Existing cockpits report the block as drift until the next `sync`.
