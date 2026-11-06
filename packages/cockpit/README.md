<p align="center"><img src="https://raw.githubusercontent.com/b0dea/cockpit/main/.github/assets/cockpit-logo.png" alt="" width="128"></p>

# @b00dea/cockpit

The cockpit CLI: where coding agents work on your whole product. One reviewed `cockpit.toml` gives Claude Code, Codex CLI and
OpenCode the same instructions, skills and guard hook, runs your own Compose stack on the live checkouts, and fails a check when a generated
file drifts. What each tool actually enforces is in the
[capability matrix](https://github.com/b0dea/cockpit/blob/main/docs/capability-matrix.md).

Install it as an exact, project-local dev dependency (the package is pre-1.0, so pin the version):

```sh
npm install --save-dev --save-exact @b00dea/cockpit
```

With pnpm or yarn, use `pnpm add -D -E @b00dea/cockpit` or `yarn add -D -E @b00dea/cockpit`, and run
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs` in place of running it through `npx --no`. The guard can prove that
path under an agent, and refuses or asks about `pnpm exec cockpit` and `yarn cockpit`.

Start with the [repository README](https://github.com/b0dea/cockpit#readme) and
[Getting started](https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md#install-cockpit).

The `cockpit` command is the only public interface; the package's exports and type declarations
serve cockpit's own tooling and are not a stable API. Supported Node.js versions are in `engines`
in this package's `package.json`.
