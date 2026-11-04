---
"@b00dea/cockpit": patch
---

`cockpit confirm <answer> --config <file>` clears an `unconfirmed` entry once the observation that verifies it passes on this machine: `preflight` with the stack up for `ports.bases`, `check` for `environment.compose_files`, and the measured runtime against the declared floor for `environment.machine`. It removes only that entry from `cockpit.toml`, keeping comments, and records what ran, when, the result and an evidence digest in `.cockpit/local/answer-confirmations`, which the guard keeps agents from writing. The guard treats the removal as non-widening only while that record matches the configuration, so an agent's own sync applies it where `[autonomy] sync = "agent"`; a missing, stale or forged record still holds it for a person. A failed observation is refused with `CONFIRM_OBSERVATION_FAILED`, and the trust decisions (`guards`, `testing`, `environment.install_policies`, `sibling`, `environment.posture`) and the answers no observation settles (`cockpit.name`, `estate.runnable`, `environment.test_data`) with `CONFIRM_PERSON_REQUIRED`.

`DECLARATION_UNCONFIRMED` now names `cockpit confirm` for the answers an observation settles and says a person confirms the rest.
