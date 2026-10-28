---
"@b0dea/cockpit": minor
---

<!-- cockpit:verified version=0.0.0 -->

Add bounded command allow and deny rules, make ripgrep prompts when ambient configuration is active,
remove obsolete generated-ownership migrations, and clean up authenticated machine-local guard state
during uninstall. Document supported extension seams and add a build-beside example.

Upgrade: installations with ownership metadata older than the current format must run
`cockpit uninstall --config cockpit.toml` before installing this version, then run `cockpit sync`.
