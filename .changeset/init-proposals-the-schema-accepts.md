---
"@b0dea/cockpit": patch
---

`init` and `document` no longer propose values the schema rejects, and say where every inferred port base came from.

- Proposed `[testing]` stage and gate ids now lead with their role (`test-api`, `targeted-api`, `full-api`, `affected-api`), so a repository whose directory name starts with a digit gets ids the schema accepts. A name too long to form a 64-character id is reported as a skipped inference instead of being proposed.
- When `ports.bases` is read from several Compose files, the proposal names each file and the variables it publishes, including the files on both sides of a conflicting default.
- A Compose file that publishes a literal host port, such as `"8080:80"` or `published: 8080`, is reported as a skipped inference that says to publish it from a variable with a default. `document` no longer claims that no Compose file at the cockpit root publishes a host port when one does.
