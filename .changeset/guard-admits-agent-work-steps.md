---
"@b0dea/cockpit": patch
---

The guard now admits the commands the shipped skills and guides tell an agent to run, as exact profiles: `test-run` on a declared gate, `work status`, `resume`, `metrics`, `intake`, `execute`, `record`, `review` and `grade`, the previews of `work sweep`, `work recover` and `work programme-mint`, and, where `browser.request_preapproval` is set, `browser drive`, `accessibility` and `screenshot`. A file these commands name (`--intent`, `--candidate`, `--event-file` and the other path options) is checked as a read, so a declared instance or `.secrets` file is denied and an undeclared `.env` prompts. Before, every one of them prompted, and Codex and OpenCode refused them. `work accept`, `work renew`, `work reverse`, `work sweep --apply`, `work recover --apply`, `work programme-mint --candidate` and `browser debugger` still need a person, and the safety page says why for each.
