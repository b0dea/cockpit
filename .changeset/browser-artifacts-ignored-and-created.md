---
"@b0dea/cockpit": patch
---

Browser screenshots can no longer be committed by accident, and the first screenshot no longer needs the artifact directory to exist.

- `cockpit sync` adds every `environment.generated_host_paths` entry, which includes the browser artifact roots such as `.browser/cli`, to the managed `.gitignore` block.
- The browser screenshot command creates its artifact root, including a missing parent such as `.browser`, before writing into it.
- When no `browser.harnesses` row is at a measured version, the work application's refusal names the declared and measured harness versions and the `sync` command to run after fixing `cockpit.toml`.
