---
loading: pull
budget: uncapped
---

<!-- cockpit:verified version=0.0.0 -->

# Work an order

Run from the cockpit root. Invoke each cockpit command through the exact project-local
executable, `./node_modules/.bin/cockpit`, or through its `npx --no` form, such as
`npx --no cockpit check --config cockpit.toml`, which runs that same binary and never downloads
one. If the binary is absent, stop: do not use a command runner that can download a missing
package implicitly. The user guide this procedure cites is installed with cockpit: open each page
with a file read from `./node_modules/@b00dea/cockpit/docs/`. In Codex's sandbox only `check`,
`sync --dry-run` and `--help` run; ask the person to approve running any other cockpit command
outside the sandbox, or to run it in a terminal.

## Work

This is the work-order loop, for a change held to criteria someone else set, graded by something
other than you, or carried across sessions. Cockpit owns the contract, the checks and the grading,
not the thinking: reuse the planning skills the harness already has.

0. **Is this a work order?** If nobody else sets the criteria and nothing must carry on in a later
   session, stop and use the cockpit-fix skill. Then read `./node_modules/.bin/cockpit work status --config cockpit.toml --json`:
   `result.wip` says how many accepted orders are open against `work.wip_cap`, `result.gates` who passes
   each step, and `result.grading` how an order earns done. Done when you can say who accepts and grades.
1. **Write the order.** Create `workorders/WO-001.md` whose YAML front-matter holds `id`, `objective`,
   `scope`, `depends_on`, `gates`, `criteria` and `non_goals`, as the *Write a work order* section of
   `./node_modules/@b00dea/cockpit/docs/work-and-browser.md` shows. Give each criterion a `text` an
   independent reviewer could not read two ways and, wherever a command can show it, a `check`. The body
   below the front-matter is free for your notes and plan.
2. **Accept it** with `./node_modules/.bin/cockpit work accept --config cockpit.toml --work-order WO-001`. Under
   `accept = "agent"` it is accepted; under `ci` it is accepted pending the `work verify` job; under
   `person` it answers `WORK_PERSON_REQUIRED`: stop, and ask the person to run the same command with
   `--interactive` in a terminal. Never type the digest yourself. Done when `work status` reports it accepted.
3. **Work test-first inside scope.** Write the failing test for a criterion, then the code, changing only
   what `scope` names. If the work needs more, edit the order and run `work accept` again to accept the
   amendment; dropping or rewriting an accepted criterion always needs a person. When you need a
   person's input, run `./node_modules/.bin/cockpit work note --config cockpit.toml --work-order WO-001 --ask --text "<question>"`
   and stop: the order is blocked until it is answered with `work answer`, which is the person's under the default policy.
4. **Check** with `./node_modules/.bin/cockpit work check --config cockpit.toml --work-order WO-001 --json`. It runs every
   criterion's check and the order's gates; a failure returns each result's outcome and the end of its
   output under `result.results`. Fix and rerun. While iterating, the declared gate
   (`./node_modules/.bin/cockpit test-run --config cockpit.toml --gate declared-gate-id --json`) is faster feedback.
5. **Before grading, review.** Run the harness's installed simplification and code-review skills, with
   security emphasis when the change touches authentication, secrets, guards or reach to non-local hosts.
   Fix their blocking findings and rerun `work check`.
6. **Grade** with `./node_modules/.bin/cockpit work grade --config cockpit.toml --work-order WO-001 --json`. Under the
   default `independent` grading an evaluator in another agent tool grades each criterion; never grade
   your own work. If it says no evaluator could run, report that cause to the person instead of
   retrying. Under `checks`, the checks decide. Under `self`, pass `--verdict met` or `unmet` and a
   `--note` saying what you checked. Anything short of passing lists each criterion's verdict and note
   under `result.criteria`, failed checks under `result.checks` and changes outside scope under
   `result.outOfScope`: go back to step 3 for each. When the person names a grader ("use Codex to grade",
   "use Claude for everything"), pass `--evaluator <tool>` (`codexcli`, `claudecode` or `opencode`) on every grade
   for the rest of the session; only that tool runs, with no fallback.
7. **Attempt cap.** Each failed check or grade counts an attempt; at `work.attempt_cap` the order is
   blocked. Record the root cause with `work note`, then report to the person, who amends the contract
   or closes the order.
8. **Close** with `./node_modules/.bin/cockpit work signoff --config cockpit.toml --work-order WO-001` once graded. An order
   that cannot be finished closes with `--partial --note <what is left>` or `--abandon --note <why>`.

Report each criterion's verdict and note, how the order closed (`work status` names it), and any step
you could not run.
