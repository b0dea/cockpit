# Check living documents and decision records

`cockpit docs check` reports documents that have drifted from the repositories they describe: a
living document that still cites a path or `make` target the repository has removed, and a
decision-record set whose numbers, index, statuses or supersedes links no longer agree. It reads
files and runs read-only Git; it changes nothing.

## Declare what to check

<!-- cockpit:ref schema=docs.living --> List the documents that must stay true under
[`[docs]`](configuration-reference.md#docs). Each entry is a glob in the cockpit's own repository, or
`<sibling slug>:<glob>` in a sibling. `decisions` and `decisions_index` optionally name a directory of
decision records and the file that links them.

```toml
[docs]
living = ["README.md", "AGENTS.md", "docs/**/*.md", "api:README.md"]
decisions = "docs/adr"
decisions_index = "docs/adr/README.md"
```

Leave append-only logs and backlogs out of `living`: they are full of proposals and history, and
are true as records of their time. Without `[docs]` the command refuses with `DOCS_NOT_DECLARED`
rather than passing on nothing, and an entry that matches no file is reported as
`DOCS_DECLARATION_UNMATCHED`.

## Run it

```sh
npx --no cockpit docs check --config cockpit.toml
npx --no cockpit docs check --config cockpit.toml --json
```

It exits 2 when it reports anything, so a CI job can run it, and the guard admits it for agents without
asking. `doctor` names it when `[docs]` is declared, but neither `doctor` nor `check` runs it: it reads
every repository's history and judges prose, a different and slower verdict.

## Stale references

A path counts when it is an inline code span or a relative link target; spans resolve from the
repository root, links from the document. A `make` target counts when an inline code span or a
shell fence runs it. Either is reported only when it existed in the repository's history and does
not exist now:

- `DOCS_REFERENCE_REMOVED`: the path was deleted, or renamed, in which case the message names
  where it went.
- `DOCS_TARGET_REMOVED`: a Makefile once defined the target and none does now.

Keying on history keeps proposals quiet: "add `make park`" names a target that never existed. A link
that never resolved is a link checker's job. npm and pnpm scripts are not checked.

## Decision records

The records are the Markdown files directly inside `decisions`, except the index, a `README.md`
and any file named as a template.

| Code | Reported when |
|---|---|
| `DECISION_NUMBER_REUSED` | two records share a numeric prefix; dated names such as `2026-09-cache.md` are not numbered |
| `DECISION_UNINDEXED` | `decisions_index` does not link a record |
| `DECISION_INDEX_ENTRY_MISSING` | `decisions_index` links a record file that does not exist |
| `DECISION_STATUS_MISSING` | the status is absent or does not start with proposed, accepted, superseded, deprecated or rejected |
| `DECISION_LINK_UNRESOLVED` | a "Supersedes" or "Superseded by" names no record |
| `DECISION_SUPERSEDED_STALE` | an accepted record supersedes another in full, and that one still says accepted |

The status is read from `status:` in YAML front matter, a `Status:` line (bold or not), or the
first line under a `## Status` heading. A supersedes reference is a link, a file name, `ADR-12`,
`#12`, or a number right after the keyword. "Supersedes 0012" replaces the whole record;
"supersedes the retry clause of 0012" replaces part of it, so 0012 only has to exist.

What this cannot see is a decision that was made and never written down; nothing here makes an
agent record one.
