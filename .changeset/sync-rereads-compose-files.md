---
"@b00dea/cockpit": patch
---

`sync` re-reads the Compose files named in `environment.compose_files` before it publishes `compose.cockpit.yml`, and refuses with `GENERATED_SOURCE_CHANGED` when one changed after the override was rendered, instead of publishing an override rendered from the old file.
