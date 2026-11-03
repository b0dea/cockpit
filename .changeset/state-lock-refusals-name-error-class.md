---
"@b00dea/cockpit": patch
---

When a state operation fails and its lock then cannot be released, the `STATE_LOCKED` refusal names the operation's error by its class (or by its system error) instead of repeating its message, which could quote the input being parsed.
