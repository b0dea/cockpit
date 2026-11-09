---
"@b00dea/cockpit": patch
---

The guard no longer refuses shell commands that only read `cockpit.toml`. `diff cockpit.toml other.toml`, `sort cockpit.toml`, `pnpm exec cockpit check --config cockpit.toml` and other launcher spellings were refused with advice to use the editing tool, though none of them edit anything. Only a command that can write the file is refused now: a redirect onto it, a writer such as `cp`, `mv`, `tee` or a Git command other than recording one, `sed -i` or `perl -i`, or any program given a write option such as `-o` or `--output`. Its refusal says so and points to the editing tool, through which the guard compares the exact change.
