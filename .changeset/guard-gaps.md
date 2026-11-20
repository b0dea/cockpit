---
'@b00dea/cockpit': patch
---

The guard now judges a recursive copy (`cp -R`, `-r` or `-a`) as it judges `rsync`, instead of refusing it as a form it does not model. Each source is read as a tree, so copying one that holds an environment file, a `.secrets` directory or a credential store is refused, and each destination is a write, so copying into a guard control, the installed cockpit or a related checkout is refused. A glob source such as `src/*` is now walked as its directory for `cp`, `rsync` and recursive searches alike, where the walk used to find nothing. A credential store's directory spelled with a trailing slash or a glob after it, as in `rsync -a "$X/.aws/" build/` or `glob('.aws/*')` in inline code, is now refused as the directory itself.
