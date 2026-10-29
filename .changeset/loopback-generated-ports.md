---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Bind generated service ports to IPv4 loopback by default while preserving explicit interface declarations.

Upgrade: Run `cockpit sync --config cockpit.toml` to regenerate Compose bindings; declare each port's `host_ip` explicitly if network exposure is intentional.
