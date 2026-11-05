---
"@b00dea/cockpit": patch
---

Recognize numbered decisions, possessive clauses and "only for" qualifiers as partial ADR
supersessions in `docs check`. Keep the original record accepted when only part changes, and
avoid treating incidental guide paths as missing ADRs while still checking record references.
