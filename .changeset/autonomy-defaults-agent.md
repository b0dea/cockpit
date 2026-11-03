---
"@b00dea/cockpit": patch
---

Every `[autonomy]` and `[work.gates]` decision now defaults to `agent` except `reset`, which stays `person`. The `[autonomy] preset` key is removed, and `cockpit init` writes the defaults as a commented block so one can be flipped to `person`.
