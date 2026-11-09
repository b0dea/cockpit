---
"@b00dea/cockpit": patch
---

The guard closes bypasses an independent security review found in the allow default:

- Input redirects are read like any named file: `sort < .env`, `base64 < ~/.ssh/id_ed25519` and `echo "$(< .env)"` are refused.
- Cockpit commands its table does not admit, such as `sync` and `upgrade`, ask however they are spelled (`npm run cockpit:sync`, `pnpm --silent exec cockpit sync`, `node --no-warnings …/cockpit.mjs sync`) and whatever an allow rule says.
- A push or history rewrite that rests on the current branch asks when an earlier command in the same call could have moved it (`git switch main && git push`).
- Exported variables that steer Git, its hooks or the command search path (`export GIT_DIR=…`, `declare -x GIT_CONFIG_PARAMETERS=…`, `HUSKY=0`, `SKIP=…`, `set -a`) ask, and so do the same prefix assignments, whatever an allow rule says.
- Protected branches: `heads/main` destinations, `git reset <rev>` and `git update-ref HEAD` on a protected branch, `git rebase <upstream> main`, `git send-pack`, `git update-ref --stdin` and GitHub API writes to a protected or deleted branch are refused or ask.
- Credential stores: their directories and anything above them (`zip -r ~/.ssh`, `rsync ~/.aws/`), hard links to them or to `.env`, the macOS `/System/Volumes/Data` spelling, and more stores (`.pgpass`, `.gnupg`, `.vault-token`, `.authinfo`, `.config/git/credentials`, Terraform, Cargo, RubyGems, Maven and Gradle credentials, 1Password's config, `*.key`).
- Commands that print a credential without naming a file (`gh auth token`, `git credential fill`, `git remote -v`/`get-url`, `aws configure get aws_secret_access_key`, `gcloud auth print-access-token`, `az account get-access-token`, `security find-generic-password -w`, `op read`) and environment dumps (`export -p`, `declare -x`, `set`, `printenv`, `ps e`, and variables named with KEY, PASS or PAT) are refused.
- Assignment values, loop items and unexpanded globs that name or can match a secret ask; any command naming a path outside the cockpit follows `[guards] external_reads`.
- Glob and magic Git pathspecs and `--cacheinfo` that reach guard controls are refused; `git checkout-index -a` and `git read-tree -u` ask.
- Abbreviated `--no-verify` spellings are refused.
- `rsync`, `ditto`, `scp`, `unzip`, `patch`, `uniq`, `split` and similar writers, and `git clone`, `init`, `worktree add` and `bundle create`, are refused when they write outside the cockpit.
- `git init --template`, `git clone --template` and `git -c` with `init.templateDir`, `diff.external`, `submodule.*`, `trailer.*.command` or `core.alternateRefsCommand` are refused.
- `/dev/tcp/<host>` redirects count as use of a declared host.
