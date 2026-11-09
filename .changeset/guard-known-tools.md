---
"@b00dea/cockpit": patch
---

The allow default now admits the development tools the guard knows, each judged by its own rules: Git and `gh`, package managers and the programs and scripts they run, languages and build and test tools running project files, reading and text utilities, file utilities inside the cockpit, archive and copy tools, `curl` and `wget`, a program the project ships inside the cockpit, and cockpit's own commands. Any other program, such as `ssh`, `kubectl`, `docker compose exec`, `osascript` or `launchctl`, asks, and so does inline code (`python3 -c`, `node -e`, `ruby -e`, `deno eval`, `find -exec`, `awk` calling `system`, `sed` with `e`): a blocked list over a shell is never complete, because a program the guard does not understand can do what the list forbids without naming it. A `[[guards.allow]]` rule admits a program your project needs; it still never admits a blocked command. `ps -o …` no longer counts as an environment dump.

Upgrade: if an agent's work now asks for a program the guard does not know, a person adds a `[[guards.allow]]` rule for that exact command in `cockpit.toml` and runs `cockpit sync`.
