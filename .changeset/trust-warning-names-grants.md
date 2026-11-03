---
"@b00dea/cockpit": patch
---

`SURFACE_GENERATOR_TRUST_WARNING` appears only when `sync` writes `.claude/settings.json`, not on every sync and `check`, and it names what the file grants: the additional directories, the approved MCP servers, and the number of command patterns in `permissions.allow`. An empty server list grants nothing and is no longer reported.
