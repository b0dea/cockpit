---
"@b0dea/cockpit": patch
---

Refuse fenced actions whose authorization expires during supervisor startup or durable acknowledgement. Carry the deadline through the action runner and preserve authenticated termination evidence when no action starts.
