---
"@b00dea/cockpit": patch
---

Correct the Claude permission guidance: native dotenv read denials also cover recognized shell reads, and symbolic links are checked against their resolved paths. Preserve secret protection while documenting the remaining dotenv-schema read limitation.
