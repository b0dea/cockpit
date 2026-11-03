---
"@b00dea/cockpit": patch
---

`init` now proposes `[testing]` from the product's own test entry points, and a cockpit with no test gate says so instead of pointing agents at a gate that does not exist.

- For a runnable product, `init` asks a new `testing` question. It proposes stages and gates from a Bazel workspace, `nx.json`, a `turbo.json` test task, a Makefile `test` target, a `package.json` test script, pytest configuration, `go.mod` or `Cargo.toml`, naming the file each came from. A tool that selects affected tests supplies the targeted gate. Answer `"none"` when the product has no tests yet.
- With no `[testing]` declared, the generated testing guide tells agents to add a characterization test in the product's existing runner, never to report work as passing, and to ask a person to declare gates.
- `doctor` warns `TESTING_GATE_UNDECLARED` when a cockpit with a runtime declares no test gate.

Upgrade: unattended `init` runs for a runnable product need a `testing` answer in the answers file (a `[testing]` table, or `testing = "none"`).
