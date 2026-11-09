---
"@b00dea/cockpit": patch
---

`git apply` and `git am` are judged by the paths their patch file's headers name, so a patch that rewrites the guard, a hook registration or an environment file is refused like any other write there; a patch read from standard input, or applied with `-p`, `--directory` or `--unsafe-paths`, asks. `unzip` is judged as a write of everything below its destination, like `tar -x`, so extracting into the cockpit root is refused, and `unzip -p`/`-c`, which print members the guard cannot list, ask.
