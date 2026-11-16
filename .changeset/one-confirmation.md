---
"@b00dea/cockpit": patch
---

One rule decides who may do what, and a person confirms in one place.

**Changed:**

- An agent may do everything except apply a `cockpit.toml` change that widens what agents may do (a new allow rule, read or write path, sibling, MCP approval or wider tool access, a `[work]` or `[testing]` change, and the like). Until a person syncs such a change, `check` and an agent's `sync` report `GUARD_CONFIG_WIDENED` and the guard keeps judging calls under the configuration last synced. `work` commands and `test-run` refuse until a widening `[work]` or `[testing]` change is synced. The guard's authority is now the configuration last synced: while `cockpit.toml` is missing, a link, unreadable or does not load, calls are judged under that record instead of being held, so the agent repairs the file with any tool, and deleting, emptying, relinking or locking `cockpit.toml` is no longer refused. `doctor` warns about an unsynced widening as `check` fails on it.
- `sync --interactive` shows one preview of what widens and of the MCP servers it would enable, with what each runs and the environment names or headers it gets, and asks one yes. On yes it writes the MCP approvals into `[mcp.approved]` itself. Nobody types or copies a hash.
- `init --answers <file>` and `init --interactive` write the cockpit right away. Review what they wrote in the diff before you commit; answers no person stated carry a `# Not stated by a person` comment.
- An agent may `reset --apply` where `[environment] seed` is declared, and preview a reset anywhere. Without a seed, a person runs `reset --interactive` and answers yes. `stacks prune --interactive` asks for a yes, not a typed digest.
- `sync` removes files it generated before and no longer generates, without asking.
- An `[mcp.approved]` entry no MCP source declares refuses every sync until it is deleted, so a yes never covers a server it did not show.
- Where the record of the configuration last synced is missing or no longer loads, as after this upgrade, an agent's `sync` is refused and `sync --interactive` asks for the yes saying it cannot show what changed, listing every MCP server the yes leaves enabled.
- A removed key in `cockpit.toml` is named with what replaced it.
- `upgrade` refuses a version older than the installed one; going back is a package-manager install.
- Work-order steps are the agent's, except the few that would let an agent lower the bar its own work is held to, and `work retry`.

**Removed:** the `[autonomy]` and `[work.gates]` tables, the top-level `unconfirmed` list, `cockpit confirm`, `init --accept-preview` and `--accept-defaults`, `work answer --interactive`, the `ci` decider in work orders, `.cockpit/policy.json`, and the `confirmed` field of a provenance (an MCP source's `provenance` is now optional).

Upgrade: delete `[autonomy]`, `[work.gates]` and the `unconfirmed = [...]` line from cockpit.toml, and `confirmed = true` from any provenance. Stop running `cockpit confirm` and drop `--accept-preview` and `--accept-defaults` from any init script. Delete `.cockpit/policy.json` and `.cockpit/local/answer-confirmations` if present. If you relied on `[autonomy] reset = "agent"`, declare an `[environment] seed` instead. Then a person runs `cockpit sync --interactive` once: it shows what widens and which MCP servers await approval (all of them under the old `mcp_approve = "agent"`), and asks for one yes.
