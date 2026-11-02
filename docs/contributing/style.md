# Documentation style

<!-- cockpit:verified version=0.0.0 -->

This policy tells cockpit contributors which Markdown rules the linter enforces and which need
a reviewer. The linter gates what a reader would trip over (a broken link, a code cockpit never
prints, a stale capture) and leaves wording to review. Project documentation and executable
agent instructions are governed separately, because the same prose rules do not fit both.

## Documentation estates

Every Markdown path belongs to an estate before a rule runs:

- Human documentation is root community material, changeset guidance, and `docs/`.
- Executable documentation is agent instructions, prompts, repository agent rules, and the
  shipped surface templates.
- Files under `fixtures/docs/` are synthetic controls and declare the estate they exercise in
  their filename.

The linter fails on a Markdown path that belongs to no estate. It takes the file list from Git,
and an empty list is an error, not a clean result.

## Purpose and audience

Human documentation has opening prose within its first twelve lines. The linter checks that the
prose is there; a reviewer checks that it says what the page is for and who it is for.

Executable instructions are exempt. They may begin directly with commands or constraints, because
rewriting them as explanation can change their behavior.

## Mechanical structure

The linter applies these structural rules to both estates:

- Heading levels do not skip an intermediate level.
- Markdown links have a non-empty label, a non-empty target, and complete delimiters, and a
  reference-style link names a defined reference.
- Admonitions use `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, or `CAUTION`.
- Front matter and fences close.

In human documentation, opening code fences also carry a language. Executable templates may
leave that language open when rendering decides the command form.

## What a reader would trip over

These checks run on every governed page:

- An internal link reaches an existing file, and its `#fragment` an existing heading. A link to a
  page marked retired fails too.
- No page under `docs/` links across the boundary between consumer pages and the contributor
  pages under `docs/contributing/`.
- An inline-code name in the shape of a diagnostic code, such as `DOC071_CODE_UNDEFINED`, is
  defined somewhere outside documentation and tests.
- A `cockpit:ref path=` marker names a tracked file.
- A console capture or screenshot carries a `cockpit:capture date= version=` marker with a real
  past date and a released version.
- The first mention of a glossary term on a page links to its heading in `docs/concepts.md`.
  Later mentions on the same page need no link.
- Generated reference pages match what their committed sources produce.

A page's `cockpit:verified version=` marker must name a real, non-future version. A missing or
stale marker is reported but does not fail the run. Generated pages and release fragments carry
no marker.

### Example

```sh
node scripts/docs-lint.mjs
```

> [!NOTE]
> The linter reports diagnostics and does not rewrite governed files.
