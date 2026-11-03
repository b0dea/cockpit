---
"@b00dea/cockpit": patch
---

`doctor` warns `COCKPIT_LAUNCHER_UNPROVEN` when the guard cannot prove that `npx --no cockpit` run in the cockpit root starts the installed cockpit (a root `.npmrc`, a `bin` or `directories.bin` in the root `package.json`, or a `node_modules/.bin/cockpit` that is not npm's link), so every printed `npx` command would prompt, and Codex and OpenCode would refuse it. It runs the guard's own check and names `./node_modules/.bin/cockpit <command> --config cockpit.toml` when that spelling is still proven.
