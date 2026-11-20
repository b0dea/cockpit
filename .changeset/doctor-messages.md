---
'@b00dea/cockpit': patch
---

Doctor, `up` and `setup` say more plainly what they found and what to do.

- Doctor's summary says, when the verdict is not pass, that it exits 0 for every verdict that produced a report, and that a script should read `.result.verdict` from `doctor --json` or run `preflight` or `check`, which exit nonzero on a failure. Exit codes are unchanged.
- A stack every session of which has ended, with none of its services running, is reported as asleep from the start. Doctor used to list about a dozen checks, such as the machine floors and the guide budget, as "evidence is missing" errors there; it now runs every check that needs no running stack.
- The checks only a running stack answers are named on one info line, `CHECKS_NEED_RUNNING_STACK` ("not checked: needs a running stack (N checks: …)"), before the first `up`, while the stack sleeps and after its sessions end. They no longer count as errors.
- A `git config --show-origin` probe that fails, as under load, is reported as a failed probe with its reason (a timeout, an exit status or output cockpit could not read) and asks for a rerun. "Git configuration origins are unsupported" now means only configuration the probe read and cockpit does not support, such as an include.
- When `up` refuses a stack whose `environment.compose_files` gained or lost a file, it says the file was added or dropped instead of that it changed. The fix is still `down`, then `up`.
- When `up` meets another session's hold, on a start that session did not finish or on a stack `down` removed, it names that session's process and the `ps -o pid,ppid,command -p <pid>` that identifies it, instead of only saying to rerun `up`. A session that ends while another session and an `up` run outside any session still hold the stack gives the same `ps` hint. The process's command line is still not printed, since it can carry credentials.
- The guard named no cause when the generated files came from another cockpit version, as after checking out a branch the upgrade has not reached: every guarded call was held as "Installed guard publication is stale or unauthenticated." It now names the installed version and the one that generated the files, with the fix: sync in a terminal, or check out the branch that upgraded cockpit. A publication that is stale for any other reason still holds calls, and now says whether its manifest failed to authenticate or was generated from a different `cockpit.toml`.
