---
'@b00dea/cockpit': patch
---

Sessions that start together, or end early, no longer strand or refuse the stack, and doctor names a start a killed session left unfinished.

- Doctor's readiness summary no longer lists a check that had no evidence as a missing prerequisite. A running stack it could not read was listed under the container runtime, whose need names the Compose floor, so a current Compose such as 5.5.0 read as too old.
- A session killed during a cold start, as an agent tool does to an MCP server it stopped waiting for, leaves the stack partly started. Doctor now says so and how many of its services run, and `up` finishes starting it. `stacks` counts such holds in `state.endedHolders`.
- An `up` or `sleep` that meets a sibling session's `sleep` waits for it instead of refusing, so sessions that end together all release the stack. A `sleep` that holds none of the stack reports `not-held` and names who holds it, instead of saying nobody does. A session that joins while another holder leaves takes the stack over instead of refusing with `CLAIM_CO_TENANT`. A refused `up` keeps the last hold on a stack that may be running, so its session's closing `sleep` stops it instead of leaving it running with no holder. If a running stack has no holder anyway, the next `up` takes it over on the ports it runs on.
- When `up` refuses a running stack whose files are unchanged, it names what changed instead of the files: the Docker or Compose version, the docker command, or the ports.
- `SESSION_STACK_RETAINED` names what keeps the stack running: another session by process ID, or an `up` run outside any session.
- Codex gets `startup_timeout_sec` for an MCP server that runs `cockpit session`: the declared `cold_start_seconds` plus the two minutes `up` may wait for a sleep, plus 30 seconds, since Codex otherwise gives up after 10 seconds. It recognises `npx`, `npm exec`, pinned versions and shell lines. Run `cockpit sync` to regenerate `.codex/config.toml`.
