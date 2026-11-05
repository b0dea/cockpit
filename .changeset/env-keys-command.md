---
'@b00dea/cockpit': minor
---

Add `cockpit env keys`, which lists the variable names environment schemas and templates declare with no value and nothing resolved, and `cockpit env schema`, which prints one `.env.schema` verbatim. An agent runs both without a prompt, so it no longer depends on reading files a native secret denial refuses.
