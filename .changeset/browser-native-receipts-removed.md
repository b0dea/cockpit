---
"@b00dea/cockpit": patch
---

Removed the browser native-transport receipt validator and the probe specifications it consumed: no command ran or recorded them, and a valid receipt left every transport `human_needed`, so the check changed nothing. The capability matrix now lists browser native transports under "Without a measurement", and the browser reference no longer mentions a record validator.
