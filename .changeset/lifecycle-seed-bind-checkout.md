---
"@b00dea/cockpit": patch
---

Make three lifecycle failures say what went wrong:

- `DATA_SEED_FAILED` now ends with the last of the seed's stderr, bounded and redacted, beside its exit status.
- A `session` that sets a service aside no longer runs the seed against the incomplete stack, where it failed and ended the session. It warns with `DATA_SEED_DEFERRED`, and the next `up` that brings every service up runs the seed.
- When a service fails to start, `up` names each of its bind sources that did not exist beforehand (`BIND_SOURCE_MISSING`). Docker creates a missing source as an empty directory, and nothing in `cockpit.toml` creates one.
- `up`, `sleep` and `down` read the checkout again when a Git command elsewhere in the repository changed it mid-read, instead of refusing with "authenticated checkout evidence is unavailable", and name that activity when it keeps happening.
