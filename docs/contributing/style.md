# Documentation style

<!-- cockpit:verified version=0.0.0 -->

This policy tells cockpit contributors which Markdown rules the linter enforces and which need
a reviewer. Project documentation and executable agent instructions are governed separately,
because the same prose rules do not fit both.

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
- Markdown links have a non-empty label, a non-empty target, and complete delimiters.
- Admonitions use `NOTE`, `TIP`, `IMPORTANT`, `WARNING`, or `CAUTION`.

Every fence closes. In human documentation, opening code fences also carry a language.
Executable templates may leave that language open when rendering decides the command form.

### Example

```sh
node scripts/docs-lint.mjs
```

> [!NOTE]
> The linter reports diagnostics and does not rewrite governed files.
