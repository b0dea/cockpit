---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Refuse cockpit package declarations outside the owned exact `devDependencies` slot
before sync changes package, lock, or ignore metadata.

Upgrade: run `npm uninstall @b0dea/cockpit && npm install --save-dev --save-exact @b0dea/cockpit`,
then run `npm run cockpit:sync`.
