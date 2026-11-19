---
'@b00dea/cockpit': patch
---

The guard refuses three everyday command shapes less often:

- `cd sub/dir && <command>` runs when `sub/dir` exists in the cockpit, so the command is judged from that directory. A name with nothing there asks, a call that sets `CDPATH` asks, and a name that could reach a credential store from the home directory, such as `Library/Keychains`, is still refused. A single name such as `cd api` still needs `cd ./api`.
- In shell the guard does not read, such as `cd api && jq '.[] | .key' f.json`, a jq field such as `.key` no longer counts as a key file, so the call asks instead of being refused. A named key file, such as `server.key`, is still refused.
- `NAME=path; cp a "$NAME/file"` is judged as the written-out path, as `"$NAME"` already was. Another expansion or a glob after the variable still asks, and a redirect still follows only a plain `"$NAME"`.
- `find … -exec` running a program that prints only names, sizes, counts or types, such as `wc -l`, `ls`, `stat`, `du` or `file`, no longer has find's roots searched for secrets. A program that prints content, such as `cat`, `head` or `grep`, still does, and so does a find whose `-name` or `-path` names a secret.
