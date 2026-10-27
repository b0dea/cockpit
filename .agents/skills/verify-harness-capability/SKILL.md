---
name: verify-harness-capability
description: Establish whether an agent harness actually enforces a capability, by driving it with a deliberately broken control alongside. Use before claiming any cell in the support matrix, and when a generated surface appears to be accepted but does nothing.
---

<!-- cockpit:verified version=0.0.0 -->

# Verify a harness capability

**This skill is for developing cockpit; cockpit does not ship it to consumers.** It answers "does this
harness really do what its documentation says", which is a question only a cockpit contributor asks.

Every cell in the support matrix is one of *enforced*, *instructed* or *unavailable*, and the
only way to tell them apart is to drive the tool. Reading its docs, its symbols, or its
acceptance of a config file establishes nothing: several cells across three harnesses accept
the configuration, report no error, and bind nothing.

## The method

1. **Write the real file and a deliberately broken twin in the same directory.** Silence
   about your file means nothing unless the broken one is named in the same run. Without the
   contrast, "no warning" and "not scanned" are indistinguishable.
2. **Drive the tool for real.** A headless invocation that exercises the capability, not a
   probe that asks the tool to describe itself — self-report is the least reliable signal
   available.
3. **Attempt the thing the capability forbids.** A read-only restriction is proved by trying
   to write and being refused. A restriction that is merely declared has not been measured.
4. **Record the verdict, the version and the date.** A capability measured against one
   version of a harness is a claim about that version.

## What counts as each verdict

- **enforced** — the attempt was refused by the harness, and you have its refusal.
- **instructed** — the instruction reached the agent and nothing would stop it acting
  otherwise. Say so plainly; this is a legitimate state, and hiding it inside "supported" is
  the defect this skill exists to prevent.
- **unavailable** — the harness offers no mechanism. Emit nothing for this cell. A line that
  reads as a control and enforces nothing is worse than its absence, because the next reader
  budgets for a control that is not there.

## Then

Write the finding into the matrix with its date, and — if the probe found a cell that had
been claimed without measurement — add the fixture that would have caught it.
