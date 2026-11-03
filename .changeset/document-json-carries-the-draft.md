---
"@b00dea/cockpit": patch
---

`document --json` now returns the incomplete draft in `result.document` instead of `result: null`, so the attributed draft is available to scripts and agents alongside its `DOCUMENT_GAP` diagnostics.
