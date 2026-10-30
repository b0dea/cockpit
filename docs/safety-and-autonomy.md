# Safety and autonomy

<!-- cockpit:verified version=0.0.0 -->

This guide explains what cockpit's guards allow, ask about, deny or cannot evaluate, and why.
It is for people reviewing generated controls and for agents working within them. Authority is
always tied to a captured invocation and declared resources, never to a command family.

The [command table](../packages/cockpit/src/command-table.ts) and
[guard evaluator](../packages/cockpit/src/guards/evaluator.ts) own these decisions. The generated
[CLI reference](cli-reference.md), [command list](command-list.md), and
[configuration reference](configuration-reference.md) describe their public inputs.

## Outcome vocabulary

| Outcome | Meaning |
| --- | --- |
| `allow` | Evaluation completed without a harder boundary; executable invocations match exact permitted profiles or the built-in read-only profile. |
| `ask` | A human decision is required. This grants no authority by itself. |
| `deny` | A hard boundary forbids the request, even with an exact grant. |
| `unavailable` | Cockpit could not authenticate or safely evaluate the request. No authority is granted. |

The evaluator scans the complete authenticated capture for hard denials before returning an
unavailable or ask result. A softer result encountered earlier cannot hide a later forbidden
operation. Malformed input or an incomplete policy is unavailable before that scan can begin.

## Cockpit and project commands

A cockpit command is allowed only when it matches an exact available public command profile.
The application authenticates the executable and working root; the command resolver checks the
bounded complete argument vector, resolved configuration path, declared services, permitted option
roles, and inspected paths. Internal guard transport and public commands marked unavailable are
excluded. Declared project build and test commands are allowed only as their exact argument
vectors in their own checkout. No command-family wildcard becomes authority.

## Hard controls and prompts

The [guard evaluator](../packages/cockpit/src/guards/evaluator.ts) denies mutation or staging of a
declared environment instance, and mutation below a secrets directory. This includes command and
patch removals as well as writes; removing a directory that contains an instance or the secrets
directory is also denied. Staging a containing directory can include an instance and is also
denied. Executable use of a declared hosted database or vendor host is denied at hostname
boundaries. Matching examines executable, argument, and environment-assignment-value roles;
redirects, heredocs, comments, and definitions do not count as executable host use. Host names are
compared after Unicode compatibility normalization, so fullwidth letters and ideographic full stops,
which resolvers fold to ASCII, do not hide a declared host.

Deleting, renaming, truncating, relinking or making unreadable the configuration file or
`.cockpit/generated-environment-ownership.json` is a hard denial, through `rm`, `unlink`, `mv`,
`git rm`, `git mv`, `find -delete`, `truncate`, `git archive` output, truncating `dd` or `tee`
writes, `ln` onto either file, a `chmod` mode that drops the owner's read permission or is copied
with `--reference`, a patch delete or move, a Write tool call with empty content, or a `>` redirect,
and so is removing a directory that contains either. Every later guarded call reads both files, so
losing one holds the agent until a human restores it. Editing the configuration in place stays
permitted, including bounded `dd conv=notrunc` and `tee` append forms under the normal write
checks; the edit takes effect only after a human runs `sync`. Writing anywhere under a `.git`
directory is also a hard denial, because Git configuration chooses programs that read-only Git
commands run, and for the same reason so is every `git config` form other than a proven read
(`--get`, `--get-all`, `--get-regexp`, `--list`, `get`, `list`, or a lone `section.key`), whatever
its scope: a global `core.pager` or `core.hooksPath` reaches every repository.

The Claude Code registration includes `NotebookEdit`: notebook cell changes use the same protected
path checks as text edits, so notebook tooling cannot write a control or environment instance.
For a configuration in a repository subdirectory, those controls belong to the configuration's
directory. Start Codex in that directory: its generated hook resolves the guard from the canonical
session directory rather than from an enclosing Git repository. Native enforcement still requires
the paired probes in the
[capability matrix](capability-matrix.md); generating a hook alone does not establish it.

Removing, renaming or directly overwriting a guard control is also a hard denial, as is removing a
directory that contains one or an executable control below a protected plugin directory. The
protected files include every harness's native MCP and permission outputs derived from the shipped
harness registry. Otherwise an exact command allow could disable a hook or change a program that a
harness starts before the next guarded call. This boundary follows folded path spellings and
authenticated filesystem identities, so alternate case and aliases do not bypass it.

The installed code the guard runs is a control too. The guard authenticates its entry point by
digest, but every other module it loads would otherwise be writable, and an edited module can turn
every hard denial into an allow. Writing, linking, changing the mode of, or removing anything inside
the running cockpit package or any package it loads is therefore a hard denial, under both the path
it was installed at and its real path, as is removing a directory that contains one. So is writing
into any `node_modules/.bin` directory of a configured root, where package scripts and `npx` find
their commands, and creating, replacing or linking a file directly inside a directory on the
harness's command search path (`PATH`) that lies within a configured root, where a planted `ls`,
`git` or `rg` would run in place of a permitted read-only command. Only absolute search path entries
are protected: a relative entry such as `.` names whatever directory a command runs in, so keep
relative entries off the `PATH` an agent harness starts with.

The evaluator resolves visible destinations for bounded `cp`, `install`, `mv`, `ln`, `git mv`,
`git archive`, `tee`, `dd`, `touch`, `truncate` and `chmod` forms, and the destination of bounded
`tar` extraction forms. Git paths use the directory selected by `git -C`. Extraction without an
explicit destination writes to the invocation's working directory.
Visible source files for bounded `cp`, `install`, `dd` and `tar` forms receive the same protected
read check as built-in read-only commands. A hard or symbolic `ln` whose target is, contains or lies
inside a secrets directory, a declared instance, a guard control or the installed cockpit is a hard
denial, because the link would reach it under a name the guard does not protect; a symbolic link's
target is checked from both the working directory and the link's own directory. Every unsupported
`tar` or `ln` mode or option is unavailable,
as is an unclassified non-read-only command whose visible operand names a control, a protected
plugin subtree or a directory containing either. These checks run before declared allows. This
screening does not inspect archive member paths or arbitrary approved script bodies, and
classifying an extraction directory does not prove that an archive cannot traverse outside it.
An exact command contract grants that authority; it is not a filesystem sandbox. To restore or
intentionally replace generated controls, stop the guarded session and have a human run
`cockpit sync --config cockpit.toml` in a terminal.

Pushes to declared protected branches are hard denials. This includes explicit protected
destinations and `git push --all` or `git push --mirror` when protected branches are declared. Missing or unresolved
destinations, including ambiguous source-only revisions, symbolic aliases, and wildcards, require
a human decision. An exact grant cannot override either boundary.

Unresolved Git execution context, destructive Git reset or clean forms, staging without explicit
paths, wrapped or environment-modifying commands, and unmatched invocation profiles produce `ask`.
An explicit removal outside configured roots also stays at `ask` even when a declared allow
matches, because cockpit has no filesystem authority to authenticate that target; review the
exact path and approve it manually or move the work under a configured root. An ungranted removal
keeps the same prompt boundary.
Broad staging can still produce a hard denial if it includes an environment instance. Unsupported
staging options or unproven pathspec grammar produce `unavailable`.

Declared rules refine that final prompt boundary. Each vector starts with the executable.
`[[guards.deny]]` matches a command-vector prefix or a contiguous command-vector sequence and may
name a safe fix. `[[guards.allow]]` matches a command-vector prefix,
optionally only at one checkout-relative working directory. Evaluation order is built-in hard
denials, declared denials, missing authority, declared allows, the built-in read-only profile, then
`ask`. An allow therefore cannot bypass a hosted endpoint, protected branch, secret path, malformed
capture or unavailable filesystem evidence. Wrapped and environment-modifying invocations are never
allowed by a declared rule because wrappers can change which program actually runs.

Malformed or oversized input, incomplete policy, escaped or symlinked path evidence, inspection
failure, and exceeded limits also produce `unavailable`. The
[invocation parser](../packages/cockpit/src/guards/invocation-parser.ts) captures bounded input once;
the evaluator accepts only its issued parser product. A reconstructed lookalike has no authority.

### Read-only commands

A built-in read-only profile lets agents inspect the checkout without a prompt, which matters most
on Codex and OpenCode, where a prompt becomes a denial. It covers exact argument shapes of `ls`,
`pwd`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `fd`, `find`, `git status`, `git diff`, `git log`,
`git show`, `git branch` with no argument or `--list`, `cockpit check`, `cockpit doctor` and
`cockpit --help`; the [read-only profile](../packages/cockpit/src/guards/read-only.ts) lists each
permitted option. Any other option falls back to the ordinary rules, including the ones that run
programs or write files: `rg --pre`, `find -exec`, `find -delete`, `fd --exec`, `git -c`,
`git --output`, `git --ext-diff` and `git diff --no-index`. Options whose value is optional, such
as `grep --context` on macOS, are accepted only in their attached `--option=value` form, so the
next word can never be misread. Git runs read-only only in a directory with its own `.git`, because
Git otherwise treats a directory holding `HEAD`, `objects` and `refs` as a repository and honours
its configuration; Git operands are inspected as files whose content may be printed. A pipeline or
chain is permitted only when every segment is.

`rg` is read-only only when `RIPGREP_CONFIG_PATH` is absent. An ambient ripgrep configuration can
inject options such as a preprocessor, so its presence falls back to the ordinary prompt rules.

Every hard denial still applies first. Reading a declared instance or anything under a `.secrets`
directory is denied under every spelling the volume resolves to it, including a case-folded
spelling of the checkout itself, and so is a recursive search rooted at or below one. Shell reads
also compare filesystem identity: a hard link to a declared instance, or to any file in the
cockpit's `env/.secrets` directory, is denied like the file itself. The guard enumerates that
directory on every call, up to 512 entries; above that bound every content read falls back to a
prompt rather than going unchecked. A hard link to a file in any other `.secrets` directory is
recognised only by its spelling. Because a recursive search reads files the guard does not name,
it falls back to a prompt whenever a declared instance or an `env/.secrets` file has a second hard
link anywhere. A path that is a symlink, lies outside the configured roots, or is an undeclared
`.env*` file falls back to a prompt, as does a search whose tree contains an instance or the
secrets directory, since the guard cannot see which files the search would read.

The guard hook sees shell commands and edits only. Claude Code's own Read, Grep and Glob tools never
reach it, so `sync` also writes Claude `Read` deny rules into `.claude/settings.json`: one for every
`.secrets` directory and one for every declared instance of every sibling, whether or not the
sibling is mounted or granted to Claude. A sibling instance's rule is anchored on the path below the
sibling's parent so the committed file is identical on every clone, and can match more than the
instance (any file with the same sibling-relative suffix), never less; an instance in the cockpit
root itself is anchored at the project root. These rules match path spellings only. Claude's native
tools cannot see filesystem identity, so a hard link to an instance or to a secrets file under a
name outside the rules stays readable to them, and so does a file reached through a symbolic link
under such a name; the guard's identity checks cover shell commands only.

## Native adapter behavior

The [transport and adapter owner](../packages/cockpit/src/guards/harness-adapter.ts) translates a
decision without adding grants or weakening hard boundaries:

| Harness | Translation and adapter exit |
| --- | --- |
| Claude Code | Allow, ask, and deny exit 0; ask and deny are carried in native decision JSON. |
| Codex CLI | Ask becomes deny, because Codex hooks have no prompt tier, and a decision a human cannot be shown must not let the call run. Allow and deny exit 0; deny is carried in native decision JSON. |
| OpenCode | Ask becomes deny, for the same reason: its plugin hook can only throw or continue. Allow exits 0; every non-allow decision exits 2. |

Unavailable or malformed decisions exit 2 on every target. Adapter exit 0 alone therefore does
not mean permission was granted.

Guard transport uses a fixed handler argument vector, normalized absolute handler and
working-directory paths, bounded standard input, and bounded output and error. Its
[transport owner](../packages/cockpit/src/guards/harness-adapter.ts) sets the bounded timeout so
a stalled handler cannot hold a guarded call indefinitely. Copied plans, failed transport,
signals, oversized output, nonzero handler
status, and invalid JSON become unavailable with exit 2. Lexical path normalization in this
adapter does not itself authenticate filesystem identity.

Generated native restrictions remain `instructed` with `pending_evidence`. If an adapter is
unavailable, no target-specific registration or read-only fragment is emitted; the shared guard
file may still be generated. Instruction projections also retain pending evidence. The
[capability matrix](capability-matrix.md) preserves source provenance, measurement dates, and
`human_needed` skill judgments. Historical adapter measurements do not prove current native
enforcement. See [harness surfaces](harness-surfaces.md) for the wider surface estate.

## Command completion and interactive decline

Public CLI outcomes in `--json` mode carry a bounded invocation record with the command name, floored
monotonic duration in milliseconds, resolved configuration path when present, and one exit status.
Human-mode runs print no record; the process exit code is the status:

| Exit | CLI meaning |
| --- | --- |
| `0` | Success. |
| `2` | Failure. |
| `130` | Clean interactive cancellation. |

`session` is the exception: once cleanup completes it exits with its command's own status, as
[the lifecycle guide](environment.md#lifecycle-and-ownership) describes.

These CLI completion statuses are separate from native adapter decision encoding. The
[CLI application](../packages/cockpit/src/cli.ts) measures elapsed time;
[invocation records](../packages/cockpit/src/invocation.ts) validate the common completion fields.

Interactive reset and baseline decline waits for cleanup before returning exit 130 with no
result. A thrown decline cleanup reports failure instead of cancellation. JSON mode, CI, and
non-terminal input cannot open an interactive confirmation. Noninteractive reset remains a preview;
baseline requires interaction. These boundaries belong to the
[operator application](../packages/cockpit/src/environment/operator-application.ts).

## Reference currentness and ownership

The maintainer [reference operations](../scripts/diagnostic-inventory.mjs) authenticate one
committed HEAD, its implementing source and shipped assets, package and build inputs, and the
matching built owner bytes. The [reference renderer](../packages/cockpit/src/references/generate.ts)
derives four complete reference files and the diagnostic index inside troubleshooting's fixed
marker region. Capability rows come from shipped restriction, instruction, and skill owners;
the renderer does not upgrade their evidence strength.

The canonical repository documentation check, `npm run lint:docs`, compares all five generated
products read-only after its Markdown checks. Missing or stale copies fail. Explicit-path and
evidence modes are scoped checks and do not establish canonical reference currentness.

Publication uses the shared
[transaction owner](../packages/cockpit/src/generated-environment/transaction.ts). Its reference
ownership record is separate from consumer generated-environment ownership. Initial admission
captures exact stage-0 Git index rows and authenticates immutable blobs by object identifier;
working-tree bytes alone cannot establish initial ownership. Later publication authenticates the
prior reference record and owned bytes. Changed owned files or an edited owned index are refused.

The transaction binds troubleshooting's complete preimage, owned region, postimage, and foreign
prefix and suffix. It preserves every byte outside that region, revalidates source, build,
bootstrap, and ownership observations, and avoids replacement for identical output. A local
reference publication does not establish a public release or native enforcement.

For a refusal, use the diagnostic's implementing owner in [troubleshooting](troubleshooting.md).
Do not edit an ownership record, evidence bundle, or generated control to conceal the refusal.

## Evidence

Static configuration, source inspection, synthetic fixtures, model self-report and silence do
not prove native enforcement. The
[native evidence validator](../packages/cockpit/libexec/validate-harness-evidence.mjs) binds exact
current executable and wiring identities, generated-manifest and candidate digests, version,
bounded transcripts and validation results. Each record carries candidate and deliberately
broken-control evidence.

Missing evidence keeps cells `instructed` or `unavailable`, with `human_needed` judgments still
pending. It never relaxes a hard denial or grants authority. Cutover, fallback deletion, default
changes and publication stay human decisions; a green source check or a generated reference does
not make them.
