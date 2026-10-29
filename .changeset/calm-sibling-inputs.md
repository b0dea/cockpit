---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Resolve generated service bind mounts and toolchain pins from their declared sibling checkout.
Authenticate each input against the prepared directory identity, reject symbolic path changes,
and keep browser-runner inputs and generated outputs within the cockpit checkout.
