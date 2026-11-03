---
"@b00dea/cockpit": patch
---

The guard answers a default `rg` search faster in a checkout with large ignored directories such as `node_modules`, and stops asking about files ripgrep never reads.

- Git now names each ignored directory once instead of listing everything inside it, so the check no longer grows with the size of `node_modules`. Its Git queries for one search, and for several searched paths, run together.
- An `.ignore` or `.rgignore` file or a `.jj` directory inside an ignored directory no longer makes the guard ask: ripgrep does not enter that directory. The same entries in a directory ripgrep does enter still make it ask.
- A tree or repository can hold up to 1024 environment files before the guard stops naming them, up from 256. Above that bound it still asks.
