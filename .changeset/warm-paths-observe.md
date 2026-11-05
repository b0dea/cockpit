---
"@b00dea/cockpit": patch
---

Exclude empty, dot and parent-relative PATH entries from observation tool discovery, so sync, check, doctor and docs check can use existing absolute tools without executing a command from the working directory. Preserve strict executable discovery for guards, sessions, evaluators and MCP commands, and continue refusing noncanonical absolute entries.
