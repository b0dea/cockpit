---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Fix a defect

## Running cockpit

- Run every command from the cockpit root, the directory holding `cockpit.toml`, through the
  installed package entrypoint, for example `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml`.
  This path resolves to the installed package even when pnpm writes a shell shim in `node_modules/.bin`.
  `npx --no cockpit <command>` and the `.bin` launcher count only where the guard can prove they
  start that same package. If the entrypoint is missing, stop and ask the person to install cockpit;
  a runner that downloads a package is never a substitute.
- Take flags from each command's `--help`. With `--json`, read `result`, `diagnostics[].code`,
  `guidance[]` and `invocation.exitCode`. A diagnostic's remedy is the `guidance` entry with its
  `code` and `target`; `diagnostics[].fix` appears only for a command safe to run as printed, and
  `./node_modules/@b00dea/cockpit/docs/troubleshooting.md` covers the codes that need more; the
  other user-guide pages cited here sit beside it.
- When the guard asks before a command, the person decides in Claude Code; Codex and OpenCode deny
  instead, so hand the person the exact command to run in a terminal. A refusal that holds every
  guarded tool call (a guard message saying so, `GUARD_AUTHORITY_UNAVAILABLE` or `GUARD_CONFIG_UNSYNCED`)
  follows any edit to `cockpit.toml` or reinstall of cockpit or Node. `GUARD_CONFIG_UNSYNCED` means
  the edit does not widen what agents may do, so run
  `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml` yourself where `[autonomy] sync =
  "agent"`; any other hold clears only when a person runs it in a terminal. When the guard refuses a
  command, read the reason. To read a file, use your tool's own file reading instead of the shell. A
  refusal for secrets, writes outside the cockpit, protected branches, declared hosts or the guard
  itself is the person's: hand them the exact command and why. Do not reword, wrap or re-spell a
  command to get past the guard. If the refused command could not touch any of those, report it as a
  cockpit gap (the command, the reason text, why it is harmless) and continue with other work rather
  than asking the person to run it.
- In Codex's sandbox `check`, `sync --dry-run` and `--help` work as it stands, unless `[browser]` is
  declared, which makes the first two read cockpit's state too. Other cockpit commands need what the
  sandbox withholds: write access to the state root, which `STATE_ROOT_UNAVAILABLE` names and a person
  can grant on that directory alone, or on its nearest existing parent before it exists; the Docker
  socket; and on macOS `/bin/ps`. First inspect the named failure and request only the missing
  access through the native approval mechanism. Prepare the concrete command and reason before
  asking; preserve existing grants. Under `codex exec`, which cannot ask, hand that command to the
  person. A sandbox refusal does not establish product failure.
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
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs test-run --config cockpit.toml --gate declared-gate-id --json`, with
   the ID from step 2. Any verdict but PASS exits with `TEST_GATE_UNSATISFIED`, and its fix says
   what FAIL, DEGRADED, VOID and PARTIAL each need. Done when you know what already passed and what
   already failed.
4. **Reproduce at the narrowest real boundary.** Extend the nearest behavior test through its
   public surface so it fails on this defect, and run it with the narrowest selector the gate takes.
   Start the stack with `./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config cockpit.toml` only when the
   behavior needs a live process or integration, adding `--profile <name>` for a service behind a
   Compose profile. Read `./node_modules/@b00dea/cockpit/bin/cockpit.mjs ps --config cockpit.toml --json` for each
   service's state, `./node_modules/@b00dea/cockpit/bin/cockpit.mjs logs --config cockpit.toml --service service-id`,
   naming the declared service, and `./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml --json`
   only for the runtime output the defect needs; a `STACK_INPUTS_CHANGED` warning there goes to
   *Keep checkouts and stacks current* in the cockpit-setup skill's procedure first. A command inside
   a service, such as a migration or a query, runs through
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs exec --config cockpit.toml --service service-id -- <command>`; the
   guard asks unless a `[guards] allow` rule or a declared build or test command admits it. When the
   stack will not start (no Docker, another holder, an unmeasured runtime), report the code `up`
   gives and its fix rather than proving the fix some other way. Done when a test goes red on
   exactly the observed behavior.
5. **Then change the repository that owns the defect**, and nothing else. Leave uncommitted changes
   that were already in the checkout as you found them. If you change it in a worktree rather than
   the checkout `cockpit.toml` declares, first run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs use sibling-slug /absolute/path/to/worktree --config cockpit.toml`
   so the stack, the guard and the gates use that worktree, and `use sibling-slug --clear` at step 8. For an environment or credential defect,
   follow the *Secret handling* section of the cockpit-setup skill's procedure,
   `../../cockpit-setup/procedures/setup.md` from this file, before running the declared product
   command. When the running stack must pick the change up, run
   `./node_modules/@b00dea/cockpit/bin/cockpit.mjs rebuild --config cockpit.toml --service service-id` for a change baked
   into its image, or `restart --service service-id` for one its process loads at start. Done when
   the test from step 4 passes.
6. **Prove it**: run the gate from step 3 again, complete and without a selector. Done when it
   reports PASS, or you can name the failure and its cause.
7. **Review.** Once the change is stable, simplify it, then review it independently, with security
   emphasis when the changed boundary warrants it. Reuse an installed code-review or security-review
   skill; otherwise apply that sequence directly. Fix blocking findings and rerun the gate. Done
   when no blocking finding is open and the gate result is current.
8. **Clean up.** List the files, temporary files, processes and stack claims this task created.
   Remove only the temporary files this task created; keep earlier uncommitted changes, other
   agents' files, claims other holders hold and the review results. Release a stack claim only
   with the cockpit lifecycle command (`./node_modules/@b00dea/cockpit/bin/cockpit.mjs sleep --config cockpit.toml`),
   following any approval it asks for; when cockpit cannot confirm that release is safe, keep the
   claim and report who holds it, the refusal and its output. Done when every item is removed or
   reported with the reason you kept it.

Report the defect, the files you changed, the gate results before and after, and every item you
kept.
