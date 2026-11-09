---
"@b00dea/cockpit": patch
---

The guard now allows by default. Inside the cockpit and its siblings an agent can run ordinary development commands without a prompt: Git work such as commit, merge, rebase, switch, stash, fetch, pull and pushes to work branches, builds, tests, package scripts, interpreters and `gh`. The guard refuses only its blocked list: secrets and credential stores (now including `~/.ssh` private keys, `~/.npmrc`, `~/.netrc`, `~/.config/gh/hosts.yml`, `~/.codex/auth.json`, cloud credentials and `.pem`/`id_*` key files, in every mode, and files named with `--body-file`, `-T` or `@file`), writes outside the cockpit (including `--output`, `curl -o`, `sort -o` and `sed -i`), force pushes, pushes to protected branches, remote branch deletion and rewriting a protected branch, declared hosts, changes to the guard itself (including `git -c` or `git config` keys that choose a program, and `--no-verify`), and privilege escalation. A bare `git push` is resolved to the branch it updates instead of asking. Set `[guards] default = "ask"` to keep the strict mode, where only classified read-only commands, declared commands and allow rules run without a prompt; changing it to `allow` waits for a person's sync.

Two fixes apply in both modes: a `[[guards.allow]]` rule such as `["git", "push"]` no longer admits a push whose destination is unknown or protected, and no allow rule admits a write option that leaves the cockpit or a transfer option that runs a program (`--upload-pack`, `--receive-pack`, `--exec`).

The setup, fix, explain and work procedures now tell agents to report a refusal of a harmless command as a cockpit gap and carry on, and to hand only refusals in the blocked list to the person.

Upgrade: the guard now allows by default. Most `[[guards.allow]]` entries added to work around refusals are no longer needed and can be removed; an allow entry can no longer override a blocked item. Set `[guards] default = "ask"` to keep the previous strict behaviour. A person runs `cockpit sync` after editing `cockpit.toml`.
