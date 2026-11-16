---
"@b00dea/cockpit": patch
---

**Fixed:** a download held in a variable or compared, such as a loop that waits on `c=$(curl -s -o /dev/null -w '%{http_code}' …)`, is no longer refused as running downloaded code. A download that becomes the command, feeds a shell or interpreter, or shares a call with one is still refused. The refusal for a Git checkout or patch beside other commands now says it can make a symbolic link, not that it does.
