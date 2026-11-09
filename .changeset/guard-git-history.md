---
"@b00dea/cockpit": patch
---

The guard closes more ways to rewrite a protected branch or publish what Git holds. `git config push.default` and `branch.<name>.merge` writes are refused, a push without a refspec under `push.default=matching` is refused, and one a configured `remote.<name>.push` steers asks. Pushing the stash is refused; `git stash -u`/`-a` is judged like `git add -A`; printing a stash, or patches across every ref, asks. On a protected branch, `git reset` with a mode to any other commit, `git pull --rebase` and a `git pull` that `pull.rebase` makes rebase are refused; `git pull --ff-only` stays allowed. A Git verb that is not one of Git's own commands, such as an alias, asks, `-c help.autocorrect` is refused, and `pre-commit`, `husky` and `lefthook uninstall` are refused as hook removal.
