# @b00dea/cockpit

<!-- cockpit:verified version=0.0.0 -->

This package is the cockpit CLI. cockpit boots a multi-repository product on your machine from one
`cockpit.toml`, gives Claude Code, Codex CLI and OpenCode the same instructions, skills and guard
hooks, and fails a check when any generated file drifts. What each tool actually enforces is in the
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
