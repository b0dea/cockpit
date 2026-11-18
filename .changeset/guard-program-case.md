---
"@b00dea/cockpit": patch
---

The guard now judges a program under any spelling of its name. On a case-insensitive disk, such as macOS's default, `GIT push origin HEAD:main`, `SUDO true` or `ENV` ran the real program while skipping every rule written for its lowercase name. A declared deny naming a program, such as `make release`, now also refuses the program run by its path, as in `/usr/bin/make release`.
