---
"@b00dea/cockpit": patch
---

The guard now denies reading, writing, removing, staging or linking any `.env` or `.env.*` file at any depth, declared or not; before, an agent's edit of an undeclared `.env` was allowed and `cat .env` only prompted. `.env.example`, `.env.sample`, `.env.template`, `.env.schema` and declared templates stay readable and writable, and recursive searches and Git content commands now treat those names as documentation too. The refusal points to `varlock run -- <cmd>` or the `.env.schema`. Claude Code's generated `Read` deny rules now cover `.env` and `.env.*` as well; because Claude applies a deny before any allow, its own Read, Grep and Glob tools also refuse the documentation names, which a shell `cat` still reads.
