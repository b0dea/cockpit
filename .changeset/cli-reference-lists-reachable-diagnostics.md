---
"@b00dea/cockpit": patch
---

The CLI reference now lists, under each command, the diagnostic codes that command's code path can produce. Codes raised while loading `cockpit.toml`, by the shared argument checks or by modules several commands share were missing from many commands, and some commands listed codes only another command raises. Codes every command can produce are listed once at the top of the page.
