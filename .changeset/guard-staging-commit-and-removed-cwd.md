---
"@b00dea/cockpit": patch
---

`git add` and `git commit` with a glob or a directory, such as a Next.js route `src/app/[slug]/page.tsx` or `git add -u src`, are judged by the changed and untracked paths Git lists for them, each as if named on its own. A bracket is a glob in Git, so `[slug]` also matches one-letter directories; those are judged too. `--literal-pathspecs`, `GIT_LITERAL_PATHSPECS=1` and `:(literal)` name one path each. `-A` and `-u` with a pathspec no longer judge the whole tree. A backslash in a pathspec is now read as the glob escape Git reads it as, and `git commit --pathspec-from-file` asks.

A commit message given with bundled options, such as `git commit -am` or `-qm`, is read as text, not as a path to stage, so a multi-line message no longer refuses the call. A refusal for a malformed path now names the word and the rule it broke.

A call whose working directory was removed, such as a linked worktree inside the checkout removed with `git worktree remove`, is judged as reported when a managed root holds it, so `cd` back out, writes by absolute path and Git there run.

The checks the guard repeats once a call is judged now run together, which shortens each call.
