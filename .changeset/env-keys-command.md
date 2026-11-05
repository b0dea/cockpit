---
'@b00dea/cockpit': patch
---

Add `cockpit env keys`, which lists the variable names environment schemas and templates declare with no value and nothing resolved, and `cockpit env schema`, which prints one `.env.schema` verbatim or, with `--replace-from <draft>`, replaces it atomically. An agent runs them without a prompt, so it no longer depends on files a native secret denial refuses. A draft that could hold a secret is refused, so a replacement cannot launder one out through `env schema`.
