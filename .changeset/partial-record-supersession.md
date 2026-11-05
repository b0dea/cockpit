---
"@b00dea/cockpit": patch
---

Recognize numbered decisions, possessive clauses, "only for" qualifiers and a clause-qualified
record listed after a whole one as partial ADR supersessions in `docs check`. Keep the original
record accepted when only part changes, and avoid treating incidental guide paths as missing ADRs
while still checking record references.
