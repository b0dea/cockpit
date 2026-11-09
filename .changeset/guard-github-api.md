---
"@b00dea/cockpit": patch
---

A `gh api` call that writes, through `-X`/`--method` (attached or not), `-f`/`-F` fields, `--input` or a GraphQL mutation, now asks. One that deletes or force-moves a branch ref, commits a file to a protected branch (`branch=main`), merges into one (`base=main`) or changes a protected branch's protection is refused.
