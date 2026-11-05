---
"@b00dea/cockpit": patch
---

Let a team hand two more process gates to the agent, both still a person's by default. `[autonomy] confirm_answers = "agent"` lets `cockpit confirm` confirm `cockpit.name`, `estate.runnable` and `environment.test_data`, and records the confirmation as the agent's decision under that field; trust decisions stay a person's. `[autonomy] instruction_files = "agent"` lets the guard admit `setup --write-instruction-files` and `--write-instruction-pointers`. Safety and autonomy now classifies every gate as a guardrail or a process gate, shows the shipped, stricter and most agentic setting for each, and gives a fully agentic `cockpit.toml` that keeps every guardrail.
