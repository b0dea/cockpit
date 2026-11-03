---
"@b00dea/cockpit": patch
---

The guard now admits the commands the shipped skills and guides tell an agent to run, as exact profiles: `test-run` on a declared gate, the `work` subcommands without `--interactive`, `cockpit grade --criteria`, the preview of `work recover`, and, where `browser.request_preapproval` is set, `browser drive` and `browser screenshot`. A file these commands name, such as `--criteria`, is checked as a read, so a declared instance or `.secrets` file is denied and an undeclared `.env` prompts. Before, every one of them prompted, and Codex and OpenCode refused them. `--interactive`, `work recover --apply` and `browser debugger` still need a person, and the safety page says why for each.
