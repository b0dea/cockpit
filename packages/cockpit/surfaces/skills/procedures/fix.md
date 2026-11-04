---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Fix a defect

## Running cockpit

- Run every command from the cockpit root, the directory holding `cockpit.toml`, through the
  project-local binary, for example `./node_modules/.bin/cockpit check --config cockpit.toml`.
  `npx --no cockpit <command>` starts the same binary, but the path form still runs where the
  guard cannot prove what npx starts. If the binary is missing, stop and ask the person to install cockpit; a
  runner that downloads a package is never a substitute.
- Take flags from each command's `--help`. With `--json`, read `result`, `diagnostics[].code` and
  `invocation.exitCode`. Every diagnostic names its fix, and
  `./node_modules/@b00dea/cockpit/docs/troubleshooting.md` covers the codes that need more; the
  other user-guide pages cited here sit beside it.
- When the guard asks before a command, the person decides in Claude Code; Codex and OpenCode deny
  instead, so hand the person the exact command to run in a terminal. A refusal that holds every
  tool call (a guard message saying so, `GUARD_AUTHORITY_UNAVAILABLE` or `GUARD_CONFIG_UNSYNCED`)
  follows any edit to `cockpit.toml` or reinstall of cockpit or Node. `GUARD_CONFIG_UNSYNCED` means
  the edit does not widen what agents may do, so run
  `./node_modules/.bin/cockpit sync --config cockpit.toml` yourself where `[autonomy] sync =
  "agent"`; any other hold clears only when a person runs it in a terminal. A refused command is the
  person's to run: never reword, wrap or re-spell it to get past the guard.
- In Codex's sandbox only `check`, `sync --dry-run` and `--help` work. Every other cockpit command
  there cannot read cockpit's state or the Docker socket, so a failure it reports is not evidence:
  ask the person to approve running it outside the sandbox, or to run it in a terminal. Under
  `codex exec`, which cannot ask, a person runs it.
- Ask, never invent. A port, image, command, host, purpose, name, version, role or credential comes
  from a file you read or from the person; with neither, name the gap and ask.

## Fix

A fix is a change you make and prove yourself. It needs no intake, draft, source audit or
work-order file. Use the cockpit-work skill instead when someone else must certify the result, or
the work must carry on in a later session or belongs to a programme. Ask that again whenever the
scope changes, not at hand-back.

1. **Name the defect.** Write down the expected behavior, the observed behavior and the repository
   that owns it. Done when a reader could tell the fix worked from those two sentences alone.
2. **Find the gate.** The *Testing tiers* section of the cockpit's root `AGENTS.md` lists the
   declared gates and which change each proves; pick the narrowest that covers this one. If it says
   no gate is declared, follow it instead: prove the fix with the product's own test runner, and
   report that no gate graded it. Done when you hold one gate ID, or know there is none.
3. **Record the baseline before you edit**:
   `./node_modules/.bin/cockpit test-run --config cockpit.toml --gate declared-gate-id --json`, with
   the ID from step 2. Any verdict but PASS exits with `TEST_GATE_UNSATISFIED`, and its fix says
   what FAIL, DEGRADED, VOID and PARTIAL each need. Done when you know what already passed and what
   already failed.
4. **Reproduce at the narrowest real boundary.** Extend the nearest behavior test through its
   public surface so it fails on this defect, and run it with the narrowest selector the gate takes.
   Start the stack with `./node_modules/.bin/cockpit up --config cockpit.toml` only when the
   behavior needs a live process or integration; read
   `./node_modules/.bin/cockpit logs --config cockpit.toml --service service-id`, naming the declared
   service, and `./node_modules/.bin/cockpit doctor --config cockpit.toml --json` only for the runtime
   output the defect needs. When the stack will not start (no Docker, another holder, an unmeasured
   runtime), report the code `up` gives and its fix rather than proving the fix some other way. Done
   when a test goes red on exactly the observed behavior.
5. **Then change the repository that owns the defect**, and nothing else. Leave uncommitted changes
   that were already in the checkout as you found them. If you change it in a worktree rather than
   the checkout `cockpit.toml` declares, first run
   `./node_modules/.bin/cockpit use sibling-slug /absolute/path/to/worktree --config cockpit.toml`
   so the stack, the guard and the gates use that worktree, and `use sibling-slug --clear` at step 8. For an environment or credential defect,
   follow the *Secret handling* section of the cockpit-setup skill's procedure,
   `../../cockpit-setup/procedures/setup.md` from this file, before running the declared product
   command. Done when the test from step 4 passes.
6. **Prove it**: run the gate from step 3 again, complete and without a selector. Done when it
   reports PASS, or you can name the failure and its cause.
7. **Review.** Once the change is stable, simplify it, then review it independently, with security
   emphasis when the changed boundary warrants it. Reuse an installed code-review or security-review
   skill; otherwise apply that sequence directly. Fix blocking findings and rerun the gate. Done
   when no blocking finding is open and the gate result is current.
8. **Clean up.** List the files, temporary files, processes and stack claims this task created.
   Remove only the temporary files this task created; keep earlier uncommitted changes, other
   agents' files, claims other holders hold and the review results. Release a stack claim only
   with the cockpit lifecycle command (`./node_modules/.bin/cockpit sleep --config cockpit.toml`),
   following any approval it asks for; when cockpit cannot confirm that release is safe, keep the
   claim and report who holds it, the refusal and its output. Done when every item is removed or
   reported with the reason you kept it.

Report the defect, the files you changed, the gate results before and after, and every item you
kept.
