---
"@b00dea/cockpit": patch
---

The guard asks Git what an `rg` search and a Git command would print, instead of refusing too much or too little.

- A plain `rg needle` at the root of a project with a large ignored `node_modules` asked, and Codex and OpenCode turned that into a denial. The guard now asks Git which files the repository does not ignore, as ripgrep skips the rest, so a gitignored `.env` or dependency tree no longer blocks it; an untracked `.env.local` that is not ignored still asks, and `grep -r` still walks every file.
- `git diff`, `git show` and `git log -p` printed a tracked `.env*` file, secrets file or declared instance without a prompt. They now ask while the repository's index holds one, unless limited with `-- <path>` to paths that hold none.
