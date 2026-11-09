---
"@b00dea/cockpit": patch
---

`npm exec vitest -- --run`, `pnpm -r build`, `pnpm --filter web build` and `pnpm --filter web exec vitest` no longer stop the agent. npm hands the program every word after its `--`, wherever that `--` falls, and pnpm's workspace selection runs the program in packages below the workspace root; the guard follows the program and judges it as it would judge it run directly. pnpm with `-C`/`--dir`, or with selection and a path that climbs with `..`, is still refused, because the guard cannot tell where those paths lead.
