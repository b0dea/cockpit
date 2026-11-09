---
"@b00dea/cockpit": patch
---

`gh release download` and `gh run download` are judged by their `-D` directory: refused when it is a guard directory or the `-p` patterns could match a guard file there, and asked when the file names are unknown and the directory holds guard files, as the cockpit root does. `gh repo clone` and `gh gist clone` are judged by the directory they create. GitHub Copilot's `~/.config/github-copilot`, `~/.vercel`, `~/.netlify` and `~/.heroku` are credential stores. `pnpm -r` and `pnpm --filter` count a script any workspace package declares, read from `pnpm-workspace.yaml` or a `package.json` `workspaces` list. `jq --arg`/`--argjson`/`--rawfile`/`--slurpfile`, `tail -f`, `find … -quit`, a reading command given a glob inside the roots such as `wc -l src/*.ts`, and `base64` are allowed. A Git command or operand writer naming a directory that holds guard files, such as `git restore --source=<rev> .`, now asks instead of being unavailable.
