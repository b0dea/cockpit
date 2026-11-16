---
'@b00dea/cockpit': patch
---

A refusal naming another session's hold on the stack now suggests `ps -o pid,ppid,command -p <pid>`, so one call shows whether the holder is a process your own agent started, such as an MCP server.
