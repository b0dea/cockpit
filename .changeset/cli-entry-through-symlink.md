---
"@b00dea/cockpit": patch
---

Running `dist/cli.js` through a symlinked package directory (npm link, workspaces) now runs the command instead of exiting 0 without output.
