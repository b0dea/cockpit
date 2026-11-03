---
"@b00dea/cockpit": patch
---

A new Configuration essentials page covers the `cockpit.toml` tables a typical cockpit sets, each with a minimal snippet and a link to its full reference entry.

The configuration reference is now one table per TOML table, listing every key with its type, default and constraints. Tables that recur, such as probes and provenance, are listed once and linked, and the JSON Schema is linked instead of printed, so the page is about a tenth of its former length.
