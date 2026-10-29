---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Centralize local Docker endpoint admission and admit local Windows named-pipe syntax only on Windows while preserving exact context and endpoint identity. Refuse remote, malformed and mismatched host transports consistently, and preserve Unix socket paths with internal spaces. Native Windows lifecycle remains unsupported.
