---
'@b00dea/cockpit': patch
---

A call whose words hold a `[` without its `]`, as a Python heredoc's indexing does, gets a normal answer instead of being refused with `SyntaxError`. If the guard ever fails to judge a command inside shell it does not read, it asks and names that command.
