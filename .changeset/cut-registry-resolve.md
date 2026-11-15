---
"@b00dea/cockpit": patch
---

Removed the shell-registry migration path, which no installed cockpit used.

**Removed:** `cockpit registry-resolve` and the `--registry` option of `init`. `init` now only observes the repositories it is pointed at and asks for the rest.

Upgrade: a product that still has a shell registry can run the migration once with 0.1.16 (`registry-resolve` and `init --registry`), or start from a fresh `cockpit init`.
