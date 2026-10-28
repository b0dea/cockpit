---
"@b0dea/cockpit": minor
---

<!-- cockpit:verified version=0.0.0 -->

Add bounded command allow and deny rules, make ripgrep prompts when ambient configuration is active,
remove obsolete generated-ownership migrations, and clean up authenticated machine-local guard state
during uninstall. Document supported extension seams and add a build-beside example.

Upgrade: review declared command rules, then have a human run `cockpit sync --config cockpit.toml`
in a terminal to regenerate and approve the guard.
