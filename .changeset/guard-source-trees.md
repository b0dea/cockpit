---
"@b00dea/cockpit": patch
---

`zip`, `rsync`, `scp`, `ditto` and `diff` read every file below their sources, so the guard now walks those sources as it walks a recursive search, and asks when one holds a declared instance, an environment file or a secrets directory. A copier's or archiver's operand inside the cockpit that leads through a link is refused, since the write would land wherever the link points. `ln -s` to a target outside the cockpit asks, and a link to `/`, `/System/Volumes/Data` or a volume under `/Volumes` is refused as a link to the credential stores below them.
