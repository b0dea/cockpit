---
"@b00dea/cockpit": patch
---

More commands that print a credential are refused outright rather than asked about: `gh auth status --show-token`, `gh auth git-credential`, every `git credential*` and `git-credential-*` or `docker-credential-*` helper, `git ls-remote --get-url`, `security find-*-password` with bundled flags such as `-gw`, `kubectl config view --raw`, `gcloud config config-helper`, `aws sts assume-role` and `get-federation-token`, `aws sso get-role-credentials` and `docker compose config`, which interpolates environment files. Variable names holding `PASSWORD`, `TOKEN` or `SECRET` anywhere (`PGPASSWORD`), and `*_PWD`, `*_DSN` and `*_URI`, are judged as secrets. `git remote -v` and reading `.git/config` are allowed again unless a remote URL, an `insteadOf` base or an `http.extraHeader` in the repository's configuration carries a credential.
