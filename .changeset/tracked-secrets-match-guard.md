---
"@b00dea/cockpit": patch
---

Make the tracked-secret check agree with the guard: `.env.schema` is no longer reported, `.env.dist` and tracked files below a `.secrets` directory at any depth are, and a declared environment template stays exempt.
