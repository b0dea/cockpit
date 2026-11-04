# @b00dea/cockpit

This package is the cockpit CLI: where coding agents work on your whole product. From one reviewed
`cockpit.toml` it gives Claude Code, Codex CLI and OpenCode the same instructions, skills and guard
hook across every repository of the product, runs the product's own Compose stack on the live
checkouts with a port lease per checkout, checks work orders against criteria you set, and fails a
check when any generated file drifts. What each tool actually enforces is in the
[capability matrix](https://github.com/b0dea/cockpit/blob/main/docs/capability-matrix.md).

Install it as an exact, project-local dev dependency (the package is pre-alpha, so pin the version):

```sh
npm install --save-dev --save-exact @b00dea/cockpit
```

Start with the [repository README](https://github.com/b0dea/cockpit#readme) and
[Getting started](https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md#install-cockpit).

The `cockpit` command is the only public interface; the package's exports and type declarations
serve cockpit's own tooling and are not a stable API. Supported Node.js versions are in `engines`
in this package's `package.json`.
