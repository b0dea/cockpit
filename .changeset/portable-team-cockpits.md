---
"@b0dea/cockpit": minor
---

<!-- cockpit:verified version=0.0.0 -->

Make committed cockpit identities and sibling grants portable across clone paths, keep runtime
ownership machine-local, and add exact package pinning, scripts, managed ignore rules, and a team
join guide.

Upgrade: run cockpit init for the existing target, review and commit the exact root package.json,
managed .gitignore block and updated generated files, then have each teammate run npm ci, npm run
cockpit:setup, npm run cockpit:sync and npm run cockpit:check.
