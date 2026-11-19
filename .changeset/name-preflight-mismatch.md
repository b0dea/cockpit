---
'@b00dea/cockpit': patch
---

When doctor or preflight refuse because the configuration or lifecycle stage they read no longer holds after the checks, the message now says what changed: the stage, the configuration, or which reading expired.

The guard's refusal of unread code that names the installed cockpit, such as a command held in a variable or a `node -p` script, no longer says the code changes it. It now names the plain spellings to use instead, such as `npx --no -- cockpit --version`.
