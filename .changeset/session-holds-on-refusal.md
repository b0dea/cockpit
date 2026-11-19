---
'@b00dea/cockpit': patch
---

Sessions that start together no longer leave the stack held after they end. When an agent tool starts several MCP servers at once and each runs through `cockpit session`, their `up`s used to claim an asleep or removed stack side by side, all refuse, and keep their holds, so the servers that needed the stack never started. Now one `up` starts the stack and the others wait for it, then join. An `up` that refuses gives its hold back even when another holder joined in the meantime, and a session whose `up` refused releases the stack the way its closing `sleep` would.
