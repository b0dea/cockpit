---
"@b00dea/cockpit": patch
---

The guard reads more of what agents write in a shell command, instead of refusing it unread:

- A commit message passed as `git commit -m "$(cat <<'EOF' … EOF)"`, the form Claude Code writes, is judged as the literal message. With an unquoted delimiter the body still expands, so it stays refused, and the reason now suggests quoting the delimiter or `git commit -F - <<'EOF'`.
- Brace expansion such as `src/{a,b}.ts` or `part{1..3}.md` is expanded into the words the shell runs and each word judged. Nested braces, several expansions in one word, ranges over 256 words, letter or zero-padded ranges, and braces in an assignment or redirect target stay refused.
- `command -v NAME` and `command -V NAME`, `bash script.sh` (also `sh` and `zsh`), and `sh -c '<literal command>'` are judged as commands. The commands inside a `sh -c` string, and inside any `$(…)` the guard reads, are judged like the rest of the call.
- `sudo`, `doas`, `su` and `pkexec` are refused with a reason saying privilege escalation is a person's action. A download piped into a shell or interpreter (`curl … | bash`, `wget … | python3`, `gh api … | sh`), `sh -c "$(curl …)"` and `bash <(curl …)` are refused as downloaded code.
- Commands that run code the guard cannot follow are now refused instead of judged as ordinary programs: `trap`, `let`, `coproc`, `repeat`, `[[`, shells such as `csh` or `tcsh`, programs that run the rest of their line in a form the guard does not read, such as `watch`, `unbuffer`, `chrt` or `taskset`, and builtins handed an array subscript holding `$(…)`.
- `time`, `caffeinate`, `stdbuf`, `ionice`, `noglob` and `nocorrect` are read as wrappers, like `timeout` and `nice`: the command behind them is judged, and an option the guard does not know stays refused. A wrapper's short option may carry its value attached (`stdbuf -oL`) and plain short flags may be grouped (`caffeinate -dims`).
- Refusals name a way forward: a glob suggests `rg --files -g` or `fd`, other `command` options name the forms the guard reads, and bare `env` explains that it prints the whole environment, which can hold credentials, and suggests printing one named variable.
