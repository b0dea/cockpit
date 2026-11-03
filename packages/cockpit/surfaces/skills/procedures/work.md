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

This is the work-order loop for changes a second person must certify. Cockpit owns the
contract and the independent grading, not the thinking: reuse the planning skills the harness already has.

0. **Is this a work order?** Ask whether anyone besides you must certify the result, or whether the work
   must carry on in a later session or span a programme. If not, stop and use the cockpit-fix skill: most changes are fixes, and the
   overhead costs more than it proves. Then check there is room: `./node_modules/.bin/cockpit work status --config cockpit.toml --json` lists open orders; the configured `workorders.wip_cap` bounds them, and a programme holds at most one. With no
   room, park something (step 7) before starting. Done when you can say who certifies and capacity exists.
1. **Intake.** When preparing an intent descriptor, draft contract or source audit, follow the
   examples in the *Declare work and the files it may change* section of
   `./node_modules/@b00dea/cockpit/docs/work-and-browser.md` so the closed formats bind the inspected
   request without guessing fields. Inspect applicable installed
   thinking, research, specification and planning skills, and link each selected output in the source audit.
   Record an audited empty selection when none applies. Then compile them into the work-order schema with
   `./node_modules/.bin/cockpit work intake --config cockpit.toml --intent intents/task.json --candidate drafts/task.md`.
   The contract needs the number of acceptance criteria the parser allows, each a Given/When/Then that independent reviewers could not
   disagree about, an Authority list of exact files and a verification command per criterion. Read the new ID from
   intake, then a human accepts it in a terminal with `./node_modules/.bin/cockpit work accept --config cockpit.toml --work-order WO-001 --interactive`,
   replacing `WO-001` with that ID. Cockpit refuses JSON, CI and calls without a terminal, but it cannot tell a
   person from a program driving one: never accept on the human's behalf. Done when
   `./node_modules/.bin/cockpit work status --config cockpit.toml --work-order WO-001 --json` reports it accepted.
2. **Work test-first inside Authority, one Plan step at a time.** Write the failing test for a criterion, then the code, touching only
   files the Authority lists. If the work needs another file, stop and ask for a renewed contract
   (`work renew`) rather than editing outside it. Record progress with `./node_modules/.bin/cockpit work record --config cockpit.toml --work-order WO-001 --event-file workorders/events/progress.json`;
   keep event files under `workorders/events/`, where they do not make earlier proof stale. When you need a
   person's input, record a `gap` event with your question and stop. Answers and decisions are the person's:
   `work record` refuses `resolve-gap` and `decision` events, and the person records them in a terminal with
   `./node_modules/.bin/cockpit work answer --config cockpit.toml --work-order WO-001 --event-file workorders/events/answer.json --interactive`.
   You may draft that file for them; never answer on their behalf.
3. **Check each Plan step** with `./node_modules/.bin/cockpit work execute --config cockpit.toml --work-order WO-001 --approach first-try --json`
   once its work is done, replacing `first-try` with a short name for your approach. It runs that step's declared verification command; a failure returns the command's exit
   status and the end of its output in `result.verification`. Fix and rerun. While iterating, the declared gate
   (`./node_modules/.bin/cockpit test-run --config cockpit.toml --gate declared-gate-id --json`, with its ID from `[testing.gates]`) is
   faster feedback; it does not check a step. Done when `./node_modules/.bin/cockpit work resume --config cockpit.toml --json`
   says every step has current checked proof and the order awaits grading.
4. **Before grading, run reviews.** Run the harness's installed simplification and code-review skills. Apply security emphasis
   when the change touches authentication, secrets, guards or reach to non-local hosts. Fix their blocking
   findings and re-run affected proof. Then run
   `./node_modules/.bin/cockpit work review --config cockpit.toml --work-order WO-001 --json` to run and persist cockpit's independent
   simplification, code/spec and security findings. Fix every blocking finding and repeat the command until
   all required review lanes pass. The reviews and the grade run in the first agent tool
   `workorders.evaluators` lists that can run, so one must be on `PATH` and signed in;
   if a refusal says it could not run, report that cause to the human instead of retrying.
5. **Pass the work to the evaluator** through `./node_modules/.bin/cockpit work grade --config cockpit.toml --work-order WO-001 --json`. Never grade
   your own work: the evaluator is the grader and there is no separate grader skill. The result lists each
   criterion's outcome and reasons under `result.criteria`; anything but "passed with current
   supporting evidence" sends you back to step 2 for that criterion.
6. **Attempt cap.** At the configured failed-attempt cap for one criterion, make a different move, for example a
   root-cause diagnosis in a fresh context, before a third try. Read the count from work-order state, not
   from memory: `./node_modules/.bin/cockpit work status --config cockpit.toml --work-order WO-001 --json` returns the selected
   order under `result.orders[0]`, with the counters at `result.orders[0].state.attempts`
   (step, approach, `failures`, `rootCause`), and the attempt cap is `workorders.attempt_cap`. A missing
   counter is not zero: if you cannot read it, say so and treat the step as unknown. Record the root cause
   with `work record` as above, then run `./node_modules/.bin/cockpit work execute --config cockpit.toml --work-order WO-001 --approach second-try`, which refuses a
   capped approach.
7. **Park, sweep and unpark.** `./node_modules/.bin/cockpit work sweep --config cockpit.toml` previews which untouched drafts
   would be parked to free capacity. Parking changes what counts against the cap a person set, so a person adds `--apply` to park them,
   and runs `./node_modules/.bin/cockpit work reverse --config cockpit.toml --work-order WO-001` to restore a swept order. An order a human
   parked by hand is reversed by a human, not by the sweep.

Report the outcome of each criterion with the reasons the grade gave, and name any step you could not run.
