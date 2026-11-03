---
"@b00dea/cockpit": patch
---

The guard's policy pin no longer lets a shell command past because its executable is spelled as a path or as `node <script>`. `/usr/bin/sed -i … cockpit.toml`, `/bin/cp x cockpit.toml`, `node script.js cockpit.toml`, a path spelled `git`, an `--option=cockpit.toml` operand and a `cockpit session -- …` command that names `cockpit.toml` are now hard denials like `sed -i … cockpit.toml`; only the `--config` operand of a cockpit command is left to the guard's proof that it starts the installed cockpit.
