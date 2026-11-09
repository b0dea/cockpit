---
"@b00dea/cockpit": patch
---

`curl -K`/`--config` and `wget -i`/`--input-file`, which read their URLs from a file or standard input, ask, and a declared host in a heredoc fed to `curl` or `wget` is refused like one on the command line. Running a file the same call downloads, as in `curl -o i.sh … && bash i.sh` or `chmod +x i && ./i`, asks: download it, read it, then run it in a later call. `go run` of a module path such as `example.test/a/b@latest` asks. Bundled short options such as `curl -fsSo out` and `wget -qO out` are now read as the output files they name.
