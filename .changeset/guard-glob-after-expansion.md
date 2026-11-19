---
'@b00dea/cockpit': patch
---

The guard now refuses a glob that can match a secret even after an expansion, such as `cat "$PWD"/.se*/creds.json`. A leading `$PWD` or `$HOME` no longer hides a later `.secrets` or `.env` match.
