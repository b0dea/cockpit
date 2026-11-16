---
"@b00dea/cockpit": patch
---

**Fixed:** `printf`, `test` and the other commands that read an array subscript as arithmetic are no longer refused when a `[` and a `$` appear only inside a `$(…)` they are given, as in `printf '%s' "$(sed -n '/^[a-z]/p' f | rg -c -- "- $p")"`. The command inside is judged on its own, and a subscript in the word itself, such as `"a[$(cmd)]"`, is still refused.
