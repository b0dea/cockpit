---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Work an order

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
  guarded tool call (a guard message saying so, `GUARD_AUTHORITY_UNAVAILABLE` or `GUARD_CONFIG_UNSYNCED`)
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

## Work

This is the work-order loop, for a change held to criteria someone else set, graded by something
other than you, or carried across sessions. Cockpit owns the contract, the checks and the grading,
not the thinking: reuse the planning skills the harness already has.

0. **Is this a work order?** If nobody else sets the criteria and nothing must carry on in a later
   session, stop and use the cockpit-fix skill. Otherwise read
   `./node_modules/.bin/cockpit work status --config cockpit.toml --json`: `result.wip` says how many
   accepted orders are open against `work.wip_cap`, `result.gates` who passes each step, and
   `result.grading` how an order earns done. If the order already exists, resume it at the step its
   state names: draft at step 2, accepted at step 3, checked at step 5, graded at step 8; **stale**
   (its file or a source changed since acceptance) goes back to step 2 to accept the change, and
   **blocked** waits on the answer or decision step 3 or step 7 describes. Done when you can say who
   accepts, who grades, and which step you start at.
1. **Write the order.** Create `workorders/WO-001.md`, using an ID `work status` does not list in
   place of `WO-001` here and below, whose YAML front-matter holds `id`, `objective`, `scope`, `depends_on`, `gates`, `criteria`
   and `non_goals`, as the *Write a work order* section of
   `./node_modules/@b00dea/cockpit/docs/work-and-browser.md` shows. Take the criteria from the
   person who sets them; when one is unclear, ask rather than write your own reading. Give each
   criterion a `text` an independent reviewer could not read two ways and, wherever a command can
   show it, a `check`. The body below the front-matter is free for your notes and plan. Done when
   the person who set the criteria has seen the front-matter.
2. **Accept it** with `./node_modules/.bin/cockpit work accept --config cockpit.toml --work-order WO-001`.
   Acceptance records the commit each repository stands at, and grading counts every change since
   then against `scope`, so first ask the person what to do with uncommitted changes already in the
   checkout. Under `accept = "agent"` it is accepted; under `ci` it is accepted pending the
   `work verify` job; under `person` it answers `WORK_PERSON_REQUIRED`: stop, and ask the person to
   run the same command with `--interactive` in a terminal. Never type the digest yourself. Past
   `work.wip_cap` it refuses until an open order closes. Done when `work status` reports it accepted.
3. **Work test-first inside scope.** Write the failing test for a criterion, then the code, changing
   only what `scope` names; a file outside it that the change needs (a lockfile, a regenerated
   reference, a changeset) is judged at grading, so change nothing else. If the work needs more, edit
   the order and run `work accept` again to accept the amendment: dropping a criterion or gate always
   needs a person, a rewritten criterion or widened scope needs one under `checks` grading, and
   otherwise the next grade judges whether your amendment lowered the bar. When you
   need a person's input, run
   `./node_modules/.bin/cockpit work note --config cockpit.toml --work-order WO-001 --ask --text "<question>"`
   and stop: the order is blocked until it is answered with `work answer`, which under `answer =
   "person"` only a person can run. When `work accept` or `work status` lists `relatedDecisions`,
   read those decision records before changing the code they name. When the work makes a lasting
   decision (a format, a boundary, a dependency, an option rejected), record it with
   `./node_modules/.bin/cockpit work note --config cockpit.toml --work-order WO-001 --decision --text "<title>"`
   and resolve it with `work decide --decision <n> --record` (adding `--supersedes <number>` when it
   replaces an older record), then replace every placeholder in the record it writes;
   `--record-file <path>` cites a record that already exists, and `--none --reason "<why>"` resolves
   one that turned out not to last. Update the documentation that describes behaviour you change.
   This needs `[docs] decisions` in `cockpit.toml`, and nothing enforces it under
   `[work] grading = "checks"`. Done when every criterion has code and a test that passes.
4. **Check** with `./node_modules/.bin/cockpit work check --config cockpit.toml --work-order WO-001 --json`.
   It runs every criterion's check and the order's gates; a failure (`WORK_CHECK_FAILED`) returns
   each result's outcome and the end of its output under `result.results`. Fix and rerun. While
   iterating, the declared gate
   (`./node_modules/.bin/cockpit test-run --config cockpit.toml --gate declared-gate-id --json`) is
   faster feedback. Done when `work check` exits 0.
5. **Before grading, review.** Run the harness's installed simplification and code-review skills,
   with security emphasis when the change touches authentication, secrets, guards or reach to
   non-local hosts. Fix their blocking findings and rerun `work check`. Where `cockpit.toml` declares
   `[docs]`, also run `./node_modules/.bin/cockpit docs check --config cockpit.toml --json` and fix
   each finding your change caused: a living document citing a path or `make` target you removed, or
   a decision record out of step with its index. Done when no blocking finding is open, `work check`
   still exits 0 and `docs check` reports nothing your change caused.
6. **Grade** with `./node_modules/.bin/cockpit work grade --config cockpit.toml --work-order WO-001 --json`.
   Under the default `independent` grading a fresh read-only evaluator grades each criterion, in
   another listed agent tool when there is one; never grade your own work. When no evaluator can run
   (`EVALUATOR_UNAVAILABLE` or `EVALUATOR_RUN_FAILED` in the refusal: none on `PATH`, signed out,
   rate-limited or timed out), the refusal names each tool's cause and the command that fixes it:
   report that to the person instead of retrying. A warning
   `EVALUATOR_FELL_BACK_TO_RUNNING_TOOL` means the tool doing the work graded it; pass it on. Under
   `checks`, the checks decide, and any change outside scope fails. Under `self`, pass
   `--verdict met` or `unmet` and a `--note` saying what you checked, naming each path in
   `result.outOfScope` and each flagged test file with why its change is needed; the checks still run
   and a failed one fails the grade. Cockpit adds standing criteria for changes outside scope
   (`scope-changes-necessary`), flagged test changes (`test-changes-justified`) and your amendments
   (`amendments-hold-bar`), and with `[docs]` declared for recorded decisions
   (`decisions-recorded`) and updated documentation (`docs-updated`). Anything short of passing
   (`WORK_GRADE_UNSATISFIED`) lists each criterion's verdict and note under `result.criteria` and
   failed checks under `result.checks`: go back to step 3 for each, reverting a change outside scope
   or a test change the grade calls unneeded. `WORK_TEST_WEAKENED` means a test change was not accepted: restore the test, or under
   `checks` grading acknowledge a legitimate change with `work acknowledge --note <why>`. When
   `amendments-hold-bar` is unmet, the next amendment is a person's: report it. When the person names a grader ("use Codex to
   grade", "use Claude for everything"), pass `--evaluator <tool>` (`codexcli`, `claudecode` or
   `opencode`) on every grade for the rest of the session; only that tool runs, with no fallback.
   Done when the grade passes.
7. **Attempt cap.** Each failed check or grade counts an attempt; at `work.attempt_cap` the order is
   blocked. Record the root cause with `work note`, then do what the refusal names: close it with
   `work signoff --partial` or `--abandon`, or amend the contract, yourself where `[work.gates]` gives
   that step to the agent, and otherwise hand the person the command. Done when the order is closed or
   amended, or the person has the cause and the command.
8. **Close** with `./node_modules/.bin/cockpit work signoff --config cockpit.toml --work-order WO-001`
   once graded; under `signoff = "person"` it answers `WORK_PERSON_REQUIRED` as step 2 describes.
   It refuses while a recorded decision is unresolved or its record still holds placeholders.
   An order that cannot be finished closes with `--partial --note <what is left>` or
   `--abandon --note <why>`. A command refused because another holds the order's lock: when that
   command crashed, run `work recover --work-order WO-001 --apply`, which removes the lock only once it
   has shown the holder gone and otherwise names what it could not check. Done when `work status` names how it closed.

Report each criterion's verdict and note, how the order closed (`work status` names it), and any
step you could not run.
