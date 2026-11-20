# Migrating an existing setup

For a team that already guards its agents with its own PreToolUse hook and runs its stack with
`make up`, `make down` and `make reset`. Move one layer at a time and keep the old path runnable
until the new one passes, as [Adopt an existing setup](getting-started.md#adopt-an-existing-setup)
describes.

## See the destination first

The `init` preview writes nothing. Beside the files it would write (`writes`), its interview lists
what cockpit takes over from the repositories (`interview.takesOver`) and what stays theirs
(`interview.staysYours`): committed agent settings, Makefile targets that run Docker Compose, and the
Compose files cockpit reads but never edits.

```sh
./node_modules/@b00dea/cockpit/bin/cockpit.mjs init . --target <tool> --json
```

## Move a PreToolUse guard and its cases

Once `sync` has installed cockpit's guard, replay the old guard's cases through both:

```sh human-only: runs the named hook program
./node_modules/@b00dea/cockpit/bin/cockpit.mjs adopt --config cockpit.toml \
  --import-guard .claude/hooks/guard.sh --cases guard-cases.json
```

The cases file is a JSON array of `{"id", "command", "cwd"?, "expect"?}`, with `cwd` relative to
the cockpit root. Convert shell-driven cases to it once.
Each case goes to both hooks as the PreToolUse payload Claude Code sends for a Bash call, so each
hook judges the command and runs none of it. The old hook is still a program: it runs once per case
with only `PATH`, `HOME` and `CLAUDE_PROJECT_DIR` set and a 30-second timeout, so it is a person's
command and the guard asks before an agent runs it.

The report sorts the cases into refused by both, refused only by the old guard, and refused only by
cockpit, each with the reason. For each old-only refusal of a single command it prints the narrowest
[`[[guards.deny]]`](safety-and-autonomy.md#declared-rules) prefix that refuses it and no case the
old guard allowed; split a case that chains commands to get one. It refuses to start while
cockpit's own guard cannot judge (run `sync` first), and exits 2 when a hook failed on a case,
naming it. It writes nothing: review each entry, drop the refusals you no longer want, add
the rest to `cockpit.toml` and run `sync`. The source is
[guard-import.ts](../packages/cockpit/src/guards/guard-import.ts).

Keep the old hook running until the replay shows no gap you care about. Moving the team's settings
file under `cockpit/adopted/` ([Adopt existing agent settings](getting-started.md#adopt-existing-agent-settings))
keeps its hooks beside cockpit's guard; delete the old hook from the adopted copy when you retire it.

## Move a local Compose stack

| Before | After |
| --- | --- |
| `make up` | `cockpit up`, or `cockpit session -- <agent>` |
| `make down` | `cockpit down` (keeps data volumes) |
| `make reset` (down with volumes, then seed) | `cockpit reset`, with `resettable_volumes` and `seed` under `[environment]` |

Declare the existing file in `compose_files`. Name the volumes `make reset` wiped in
`resettable_volumes`, and its seed command in `seed`, so `up` seeds an empty stack and an agent may
apply a reset ([Demo data, test users and roles](environment.md#demo-data-test-users-and-roles)).
cockpit runs the stack under its own [project name](environment.md#compose-project-name), so its
volumes start empty: seed them, or [restore data](compose-patterns.md#seed-or-restore-data).

**Stop the old stack before the first `cockpit up`.** Both controllers start the same services from
the same Compose file against the same checkout, each under its own project, and neither stops the
other's containers. The old stack keeps host ports that `up` will not lease while something listens
on them, and two copies of a service writing the same bind-mounted files spoil each other's work.
Run the old `make down`, then `cockpit up`, and keep the Makefile targets only as wrappers that call
cockpit.

When everything the old path did passes under cockpit, retire it as
[Complete the cutover](getting-started.md#complete-the-cutover) describes.
