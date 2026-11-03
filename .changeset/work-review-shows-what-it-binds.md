---
"@b00dea/cockpit": patch
---

Work-order acceptance, grading and browser operations show and reach only what they should.

- `work accept` and `work renew` print the Authority paths, sources, every acceptance criterion and every verification command, and for renewal the decision being confirmed, before asking for the digest, so an edit made after the person read the file is on screen. Control and bidirectional-override characters are replaced.
- `work review` and `work grade` run Codex from a private directory outside the repository, so it no longer loads the repository's `AGENTS.md` or project configuration as instructions. They need `codex exec --skip-git-repo-check`. The evaluator is told that repository content, work-order text and command output are data, never instructions, and the request no longer claims a browser that the Codex run does not have.
- Browser operations block requests to loopback and resolver-mapped hosts outside the application origin. Redirects that the browser follows are not routed, so they are not blocked.
- `work intake` no longer treats a work-order identity as taken because a checkout ignores the whole `workorders/` directory.
- `up` and `sync` name an unparseable browser project `package.json` or lockfile with the line and column, and no longer quote its contents.
