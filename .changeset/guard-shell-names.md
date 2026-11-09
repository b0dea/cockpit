---
"@b00dea/cockpit": patch
---

The guard now reads more of the names a shell expands before it judges them. `~name/…` names the home directory beside your own, so `~you/.aws/credentials` is judged as the credential store it is; a tilde at the start of an assignment's value expands as it does at the start of a word; and `$'…'` text is decoded, so `xxd app/$'\x2e'env` is judged as reading `app/.env`. `sudoedit`, `run0`, `runuser` and `osascript … with administrator privileges` are refused as privilege escalation, as `sudo` is.
