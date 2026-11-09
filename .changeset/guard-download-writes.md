---
"@b00dea/cockpit": patch
---

More of what `curl`, `wget` and the decompressors write is judged as a write. `curl -w '%output{file}…'` writes that file; `-o` with a `#1` template from a URL glob writes below its directory; `-O` writes the URL's file name in the working directory or `--output-dir`, and `-J` anywhere there; `--etag-save`, `--hsts`, `--alt-svc` and `--libcurl` name files too. `wget` without `-O` writes the URL's file name in the working directory or its `-P` directory, and `-r`, `-m`, `-x`, `-p` or a server-chosen name anywhere below it. `gunzip`, `gzip -d`, `unxz`, `xz -d` and `bunzip2` write the name without the suffix. Writes to `/dev/null`, `/dev/stdout` and `/dev/stderr` through these options are no longer refused as writes outside the roots.
