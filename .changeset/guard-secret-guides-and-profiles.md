---
"@b00dea/cockpit": patch
---

`sync` refuses a sibling guide that is, or links to, a `.env` or `.env.*` file, a file below a
`.secrets` directory or a declared environment instance, with `PROJECTION_GUIDE_SECRET`, instead of
copying its contents into the root `AGENTS.md` that every agent reads.

The guard admits `up --profile <name>` and `session --profile <name>` from an agent only for a
profile already in `environment.profiles` that mounts no sibling with `gate = "operator"`; any other
profile asks for a person.
