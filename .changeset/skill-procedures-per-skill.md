---
"@b00dea/cockpit": patch
---

Each shipped skill now installs only its own procedure (`procedures/setup.md`, `explain.md`, `fix.md` or `work.md`) instead of a full copy of one shared procedure, so a tool's skills directory holds about a third of the lines it did. Bootstrap, secret handling and the other setup steps live in the setup procedure, which the explain and fix procedures point to. The setup procedure gains *Add or remove an agent tool*. The capability matrix says which tools are written by default and which only when listed.
