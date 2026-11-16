---
"@b00dea/cockpit": patch
---

**Fixed:** a glob or a missing file name below a package-manager link inside the checkout, such as `rg -n createSocket node_modules/pkg/src/*.js` under pnpm, is judged where the link leads instead of being refused as a path the guard could not inspect. A glob that can match an environment file there is still refused.
