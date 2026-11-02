---
"@b0dea/cockpit": patch
---

`check` now warns with `COMPOSE_PORT_ALL_INTERFACES` when a Compose file publishes a port without a host interface, which Docker binds on every interface. Writing `127.0.0.1` (or `0.0.0.0`, when the exposure is intended) silences it. The extended example now binds loopback, and the example READMEs reach the stack through its leased port variable instead of a fixed port.
