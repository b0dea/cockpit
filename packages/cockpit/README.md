# @b0dea/cockpit

<!-- cockpit:verified version=0.0.0 -->

This package README is for npm consumers installing the cockpit CLI. cockpit runs the environment
your AI coding agents work in. Declare the product's repositories once in `cockpit.toml`;
cockpit starts the stack against live local checkouts, renders agent instructions and skills,
and hands finished work to an independent evaluator. Guard and permission support depends on
its target's measured
[capabilities](https://github.com/b0dea/cockpit/blob/main/docs/capability-matrix.md).

The package is pre-alpha and not yet published. The
[installation guide](https://github.com/b0dea/cockpit/blob/main/docs/getting-started.md#install-cockpit)
owns the project-local install and verified source-package fallback. The
[repository README](https://github.com/b0dea/cockpit#readme) has the synthetic quickstart,
documentation and current limits.

The CLI command is `cockpit`. Supported Node.js versions: see `engines` in this package's `package.json`.
