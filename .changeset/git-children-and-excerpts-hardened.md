---
"@b00dea/cockpit": patch
---

Every Git command cockpit runs now carries `core.fsmonitor=false` and `core.hooksPath=/dev/null`, including the `ls-files` and `log` reads behind `docs check`. `pull` skips a checkout whose own Git configuration sets `core.sshCommand`, `core.askPass`, `core.gitProxy`, `credential.helper` or a remote's `uploadpack`/`receivepack`, as `PULL_SKIPPED` naming the key, because the fetch would run that command.

Browser console and error excerpts are redacted like other diagnostics and lose URL query strings and fragments before they are kept as evidence. `docs check` redacts Git's error text in its diagnostics.
