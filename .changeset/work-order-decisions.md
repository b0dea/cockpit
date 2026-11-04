---
"@b00dea/cockpit": patch
---

Work orders record their lasting decisions. With `[docs] decisions` declared, `work note --decision --text "<title>"` records a decision on an order and `work decide` resolves it: `--record` writes the next numbered decision record (with `Work order:` back-link, placeholders to fill and an index line in `decisions_index`), optionally marking an older one `superseded by` it with `--supersedes`; `--record-file` cites an existing record; `--none --reason` says it is not lasting. `work signoff` refuses every closure while a decision is unresolved or its record still holds placeholders, `work verify` fails when a cited record is gone or no longer names its order, and `work status` lists open decisions. `work accept` and `work status` list decision records that name paths in the order's scope. Under `independent` and `self` grading, a declared `[docs]` adds the standing criteria `decisions-recorded` and `docs-updated` to every grade.

A work-order scope or source spelled `<sibling>:../path` is now refused when the order is read, as `../path` already was.
