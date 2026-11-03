# Documentation style

This policy tells cockpit contributors which Markdown rules the documentation checks enforce and
which need a reviewer. The checks gate what a reader would trip over (a broken link, a code
cockpit never prints, a reference to something that does not exist) and leave wording to review.

## What the checks enforce

`npm run lint:markdown` runs markdownlint over every Markdown file with the rules in
[`.markdownlint-cli2.jsonc`](../../.markdownlint-cli2.jsonc): heading levels do not skip, fenced
code names its language, links are neither empty nor reversed, and link fragments and reference
definitions resolve.

`npm run lint:links` runs lychee offline: every relative link reaches a file and every `#fragment`
a heading. The weekly external link report runs lychee against the network and gates nothing.

`npm run lint:docs` runs [`scripts/docs-lint.ts`](../../scripts/docs-lint.ts), the checks only
cockpit can make:

- A `cockpit:ref` comment names something that exists: `path=` a tracked file, `schema=` a field in
  `packages/cockpit/cockpit.schema.json`, `command=` a command or command group, and `consumer=` a
  file cockpit reads or writes in a consumer's cockpit.
- An inline-code name in the shape of a diagnostic code, such as `DOC071_CODE_UNDEFINED`, is
  defined somewhere outside documentation and tests.
- The first mention of a glossary term on a page links to its heading in `docs/concepts.md`.
  Later mentions on the same page need no link.
- `docs/README.md` links every consumer page and the contributor indexes link every page under
  `docs/contributing/`, and neither index links across that boundary.

Generated pages are checked by regenerating them: see
[CLI completion and generated references](cli-completion-and-references.md).

## What needs a reviewer

Human documentation opens with prose that says what the page is for and who it is for.
Executable instructions (agent rules, skills and the shipped surface templates) may begin directly
with commands or constraints, because rewriting them as explanation can change their behavior.

### Example

```sh
npm run lint:docs
```

> [!NOTE]
> The checks report findings and do not rewrite files.
