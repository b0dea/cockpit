---
"@b00dea/cockpit": patch
---

The guard recognises a cockpit command by any path that leads into the installed package, however it is spelled: `node ./node_modules/@b00dea/./cockpit/dist/cli.js sync`, another case on a case-insensitive volume, or `node cockpit/dist/cli.js` from inside `node_modules/@b00dea`. Such a command is judged as cockpit, and while `cockpit.toml` holds an unapproved widening edit, any of them that runs `sync` or `upgrade` is refused, as the proven launcher spellings already were.
