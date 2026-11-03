---
"@b0dea/cockpit": patch
---

`init` no longer strands a cockpit after it writes `cockpit.toml`, and its refusals say what mismatched and how to recover.

- An `environment.generated` or sibling answer whose host operation runs anything but `node` is refused at that answer (`DOCUMENT_CONFIGURATION_ANSWER_INVALID`, naming the operation and its fix) instead of after `cockpit.toml` was written, where loading it refused `GENERATED_HOST_EXECUTABLE_UNSUPPORTED` and the answers could no longer be reset.
- Every stop after `cockpit.toml` is written adds `INIT_VERIFICATION_INCOMPLETE`, whose fix says to correct `cockpit.toml` itself and rerun `init --accept-preview <previewSha256>` to finish. `--reset-answer` at that point (`INIT_ANSWER_RESET_UNAVAILABLE`) now names the same recovery, or `sync` once `init` has finished.
- A plain `sync` run before an interrupted `init` finished adopts the setup skill files `init` published for that cockpit, when they still hold exactly the bytes `init` recorded, instead of refusing them with `SURFACE_STATE_CONFLICT`. When `init` itself cannot take them over, `GENERATED_OWNERSHIP_INVALID` now says why and how to restore them.
- Remedies that delete a file (`SURFACE_STATE_CONFLICT`, an edited adopted settings file) tell an agent to ask the person who owns the cockpit first. The conflict for a file that already holds what sync would write now says that, instead of "not proof of ownership".
- A root removed and recreated at the same path no longer resumes the old bootstrap state and fails `GENERATED_OWNERSHIP_INVALID`: when none of the files `init` published, nor `cockpit.toml`, exist, `init` reports `INIT_STATE_RESTARTED` and starts again from the preview.
- `init` no longer proposes a sibling `remote` that is a local path or other non-https, non-ssh URL, which every `preflight` refused with `GIT_COMPARISON_REMOTE_MISMATCH`; the sibling is proposed with `acquire = "none"` and the reason. A declared remote of that kind now makes `GIT_COMPARISON_REMOTE_MISMATCH` say why it cannot be compared.
- `DOCUMENT_ESTATE_TOPOLOGY_MISMATCH` names the repositories `init` observed, the declared ones it did not, and the ones the answer omits, and its fix says to add other repositories after `init` with `sibling add`.
