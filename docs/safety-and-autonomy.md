# Safety and autonomy

<!-- cockpit:verified version=0.0.0 -->

This page is for people reviewing the controls cockpit generates and for agents working within
them. It says what the guard allows, asks about, denies or cannot evaluate, and why. A permission
always applies to one exact command and declared resources, never a whole command family.

The [command table](../packages/cockpit/src/command-table.ts) and
[guard evaluator](../packages/cockpit/src/guards/evaluator.ts) own these decisions; the generated
[CLI reference](cli-reference.md), [command list](command-list.md) and
[configuration reference](configuration-reference.md) describe their public inputs.

## Outcome vocabulary

| Outcome | Meaning |
| --- | --- |
| `allow` | Evaluation completed without a harder boundary; executable invocations match exact permitted profiles or the built-in read-only profile. |
| `ask` | A person must decide. An `ask` result permits nothing by itself. |
| `deny` | A hard boundary forbids the request, even with an exact grant. |
| `unavailable` | Cockpit could not verify or safely evaluate the request, so it permits nothing. |

The evaluator scans the whole captured command for hard denials before returning `unavailable` or
`ask`, so a softer result found earlier cannot hide a later forbidden operation. Malformed input or
an incomplete policy is `unavailable` before that scan can begin.

## Cockpit and project commands

A cockpit command is allowed only when it matches an exact available public command profile. The
application verifies the executable and working root; the command resolver checks the bounded
complete argument vector, resolved configuration path, declared services, permitted option roles
and inspected paths. Internal guard transport and public commands marked unavailable are excluded.
Declared project build and test commands are allowed only as their exact argument vectors in their
own checkout. A wildcard over a command family never grants permission.

## Hard controls and prompts

Evaluation runs in this order: built-in hard denials, declared denials, checks cockpit could not
complete, declared allows, the built-in read-only profile, then `ask`. A declared allow therefore
cannot bypass any boundary below.

### Instances, secrets and hosted endpoints

The guard denies mutation or staging of a declared environment instance, and mutation below a
secrets directory. That covers command and patch removals as well as writes, removing a directory
that contains an instance or the secrets directory, and staging a containing directory that could
include an instance.

Executable use of a declared hosted database or vendor host is denied at hostname boundaries.
Matching examines executable, argument and environment-assignment-value roles; redirects,
heredocs, comments and definitions do not count as executable host use. Host names are compared
after Unicode compatibility normalization, so fullwidth letters and ideographic full stops, which
resolvers fold to ASCII, do not hide a declared host.

### Configuration, Git and guard controls

Every guarded call reads the configuration file and
`.cockpit/generated-environment-ownership.json`, so losing either holds the agent until a human
restores it. Deleting, renaming, truncating, relinking or making either unreadable is a hard
denial, and so is removing a directory that contains either. The guard recognises this through
`rm`, `unlink`, `mv`, `git rm`, `git mv`, `find -delete`, `truncate`, `git archive` output,
truncating `dd` or `tee` writes, `ln` onto either file, a `chmod` mode that drops the owner's read
permission or is copied with `--reference`, a patch delete or move, a Write tool call with empty
content, and a `>` redirect. Editing the configuration in place stays permitted, including bounded
`dd conv=notrunc` and `tee` append forms under the normal write checks; the edit takes effect only
after a human runs `sync`.

Writing anywhere under a `.git` directory is a hard denial, because Git configuration chooses
programs that read-only Git commands run. For the same reason, so is every `git config` form other
than a proven read (`--get`, `--get-all`, `--get-regexp`, `--list`, `get`, `list`, or a lone
`section.key`), whatever its scope: a global `core.pager` or `core.hooksPath` reaches every
repository.

Removing, renaming or directly overwriting a guard control is a hard denial, as is removing a
directory that contains one or an executable control below a protected plugin directory. Otherwise
an exact command allow could disable a hook, or change a program a harness starts, before the next
guarded call. The protected files include every harness's native MCP and permission outputs derived
from the shipped harness registry, and the MCP wrapper scripts under `.cockpit/mcp/` that those
outputs start. This boundary follows folded path spellings and verified
filesystem identities, so alternate case and aliases do not bypass it.

The installed code the guard runs is a control too. The guard checks its entry point's digest, but
an edited module it loads could turn every hard denial into an allow. So these are hard denials:

- writing, linking, changing the mode of, or removing anything inside the running cockpit package
  or any package it loads, under both its installed path and its real path, or removing a
  directory that contains one;
- writing into any `node_modules/.bin` directory of a configured root, where package scripts and
  `npx` find their commands;
- creating, replacing or linking a file directly inside a directory on the harness's command
  search path (`PATH`) that lies within a configured root, where a planted `ls`, `git` or `rg`
  would run in place of a permitted read-only command.

Only absolute search path entries are protected: a relative entry such as `.` names whatever
directory a command runs in, so keep relative entries off the `PATH` an agent harness starts with.

The Claude Code registration includes `NotebookEdit`, so notebook cell changes get the same
protected-path checks as text edits. For a configuration in a repository subdirectory, these
controls belong to the configuration's directory. Start Codex in that directory: its generated hook
resolves the guard from the canonical session directory, not from an enclosing Git repository.
Generating a hook does not establish that the harness runs it; see
[Capability states](harness-surfaces.md#capability-states).

### Destinations, sources and links

The evaluator resolves visible destinations for bounded `cp`, `install`, `mv`, `ln`, `git mv`,
`git archive`, `tee`, `dd`, `touch`, `truncate` and `chmod` forms, and the destination of bounded
`tar` extraction forms. Git paths use the directory selected by `git -C`. Extraction without an
explicit destination writes to the invocation's working directory. Visible source files for bounded
`cp`, `install`, `dd` and `tar` forms get the same protected read check as built-in read-only
commands.

A hard or symbolic `ln` whose target is, contains or lies inside a secrets directory, a declared
instance, a guard control or the installed cockpit is a hard denial, because the link would reach
it under a name the guard does not protect. A symbolic link's target is checked from both the
working directory and the link's own directory.

These are `unavailable`: every unsupported `tar` or `ln` mode or option, and an unclassified
non-read-only command whose visible operand names a control, a protected plugin subtree or a
directory containing either. These checks run before declared allows. They do not inspect archive
member paths or the bodies of approved scripts, and classifying an extraction directory does not
prove that an archive cannot traverse outside it. An exact command rule permits that command; it is
not a filesystem sandbox. To restore or intentionally replace generated controls, stop the guarded
session and have a human run `cockpit sync --config cockpit.toml` in a terminal.

### Protected branches and prompts

Pushes to declared protected branches are hard denials, including explicit protected destinations
and `git push --all` or `git push --mirror` when protected branches are declared. Missing or
unresolved destinations, including ambiguous source-only revisions, symbolic aliases and wildcards,
need a human decision. An exact grant cannot override either boundary.

These produce `ask`: unresolved Git execution context, destructive Git reset or clean forms,
staging without explicit paths, wrapped or environment-modifying commands, unmatched invocation
profiles, and any removal without a grant. An explicit removal outside configured roots stays at
`ask` even when a declared allow matches, because cockpit cannot verify a target outside the roots
it manages; review the exact path and approve it, or move the work under a configured root. Broad
staging can still be a hard denial if it includes an environment instance. Unsupported staging
options or unproven pathspec grammar produce `unavailable`.

### Declared rules

Declared rules refine the final prompt boundary. Each vector starts with the executable.
`[[guards.deny]]` matches a command-vector prefix or a contiguous command-vector sequence and may
name a safe fix. `[[guards.allow]]` matches a command-vector prefix, optionally only at one
checkout-relative working directory. An allow cannot bypass a hosted endpoint, protected branch,
secret path, malformed capture or unavailable filesystem evidence. Wrapped and
environment-modifying invocations are never allowed by a declared rule, because wrappers can change
which program actually runs.

Malformed or oversized input, incomplete policy, escaped or symlinked path evidence, inspection
failure and exceeded limits produce `unavailable`. The
[invocation parser](../packages/cockpit/src/guards/invocation-parser.ts) captures bounded input
once; the evaluator accepts only input that parser produced, so a hand-built lookalike is refused.

### Read-only commands

A built-in read-only profile lets agents inspect the checkout without a prompt, which matters most
on Codex and OpenCode, where a prompt becomes a denial. It covers exact argument shapes of `ls`,
`pwd`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `fd`, `find`, `git status`, `git diff`,
`git log`, `git show`, `git branch` with no argument or `--list`, and the cockpit commands in
[Cockpit commands an agent can run](#cockpit-commands-an-agent-can-run). The
[read-only profile](../packages/cockpit/src/guards/read-only.ts) lists each permitted option.

- Any other option falls back to the ordinary rules, including options that run programs or write
  files: `rg --pre`, `find -exec`, `find -delete`, `fd --exec`, `git -c`, `git --output`,
  `git --ext-diff` and `git diff --no-index`.
- Options whose value is optional, such as `grep --context` on macOS, are accepted only in their
  attached `--option=value` form, so the next word can never be misread.
- Git runs read-only only in a directory with its own `.git`, because Git otherwise treats a
  directory holding `HEAD`, `objects` and `refs` as a repository and honours its configuration.
  Git operands are inspected as files whose content may be printed.
- `rg` is read-only only when `RIPGREP_CONFIG_PATH` is absent, because an ambient ripgrep
  configuration can inject options such as a preprocessor.
- A pipeline or chain is permitted only when every segment is. Redirecting output to `/dev/null`,
  `/dev/stdout` or `/dev/stderr`, or input from `/dev/null`, touches no file and does not change the
  decision.

### Cockpit commands an agent can run

| Command | Decision | Why |
| --- | --- | --- |
| `npx --no cockpit check --config cockpit.toml`, and likewise `doctor`, `preflight`, `logs --service <service>` and `sync --dry-run` | allowed | They read and report; nothing they do changes a file the guard relies on. |
| `npx --no -- cockpit --help`, `npx --no cockpit up --help`, and the version | allowed | They print and exit before any command runs. |
| `npx --no cockpit up --config cockpit.toml`, and likewise `sleep` and `down` | allowed | They act only on the stack cockpit declared and owns; `down` keeps data volumes, and deletes only from the local Docker daemon it fixes at the start of the run. |
| `npx --no cockpit runtime measure --config cockpit.toml --image <local-image>` | allowed | The probe runs a disposable stack under its own project, removes it, and records the result only in this machine's git-ignored state; `cockpit.toml` never changes. |
| `npx --no cockpit session --config cockpit.toml -- <command>` | the decision for `<command>` | A session runs its command as the agent could run it directly, so it never admits more. |
| `npx --no cockpit test-run --config cockpit.toml --gate <gate>`, with an optional `--mode` and a `--select <kind>:<value>` whose value does not start with `-` | allowed for a gate `cockpit.toml` declares | The gate runs only the stages a person declared in the reviewed configuration, the trust `up` already has. |
| `npx --no cockpit work status`, `work resume`, `work metrics`, `work intake` (`--intent` with an optional `--candidate`, or `--work-order`), `work execute`, `work record`, `work review` and `work grade`, each with `--config cockpit.toml` and its own options | allowed | They report, publish a draft a person still has to accept, or run and record the steps of an order a person accepted; review and grading run in a separate evaluator. That a `resolve-gap` or `decision` event passed to `work record` is a person's answer is instructed, not enforced: the guard sees the event file's name, not its kind. |
| `npx --no cockpit work sweep --config cockpit.toml`, `work recover --lock <lock>` and `work programme-mint --programme <programme>`, without `--apply` or `--candidate` | allowed | Without those options they only report. |
| `npx --no cockpit browser drive --config cockpit.toml`, and likewise `accessibility` and `screenshot`, with an optional `--role` | allowed where `browser.request_preapproval` is set, otherwise a prompt | They sign in and capture the declared application, so they run unprompted only on the isolated, non-production data the configuration must declare before it can set preapproval. |
| `work accept` and `work renew` | a prompt, which Codex and OpenCode turn into a denial | Each is a person's answer, in an interactive terminal, to the contract digest it displays. |
| `work sweep --apply` and `work reverse` | a prompt, which Codex and OpenCode turn into a denial | Parking or un-parking an order changes which orders count against the work-in-progress cap a person set. |
| `work recover --apply` | a prompt, which Codex and OpenCode turn into a denial | It deletes a lock once a process probe calls its holder dead, and that probe sees only this machine's processes: a holder in a container or on another host that shares the checkout looks dead to it. |
| `work programme-mint --candidate` | a prompt, which Codex and OpenCode turn into a denial | It binds the next item of a person's programme ledger to that draft for good. |
| `browser debugger` | a prompt, which Codex and OpenCode turn into a denial | It opens a headed browser for a person at this machine, on that person's explicit request. |
| `npx --no cockpit sync --config cockpit.toml`, `reset`, `sibling add` and every other command | a prompt, which Codex and OpenCode turn into a denial | They rewrite `cockpit.toml` or the guard's own files, or delete data. |

A file such a command names, like `--intent`, `--candidate` or `--event-file`, is checked as a read:
the command may quote it in a refusal. A declared instance or a file below `.secrets` is denied,
and an undeclared `.env` file, a symlink or a path outside the configured roots prompts.

Run these exactly as shown. A prefix such as `env -u NAME` or `nohup` makes any of them a wrapped
invocation, which prompts, and none needs one: `down`, `reset` and `runtime measure` choose their
Docker daemon themselves, as [Choose the Docker daemon](environment.md#choose-the-docker-daemon)
describes.

These count from the cockpit root with `--config` naming the configured `cockpit.toml`; `check`,
`doctor` and help also count from any directory. Each spelling counts only where the guard proves
it starts its own installed package:

- a path such as `./node_modules/.bin/cockpit`, or one given to `node`, must resolve to it;
- bare `cockpit` must be what the command search path finds first;
- the npx spellings in the table must run from the cockpit root with no root `.npmrc` and no `bin`
  or `directories.bin` in the root `package.json`, because npm would otherwise run that program or
  apply that configuration first. Writing an `.npmrc` anywhere inside the configured roots is
  denied, so one cannot be planted in the same command after that check. Any other npx option, or
  npx without `--no` (which may download a package), is not the installed cockpit.

Where npx cannot be proven, every npx spelling prompts, and Codex and OpenCode refuse it, while
`./node_modules/.bin/cockpit <command> --config cockpit.toml` from the cockpit root still counts.
`doctor` reports this as `COCKPIT_LAUNCHER_UNPROVEN`, using the guard's own check, and names which
spelling it can prove. The guard does not check which `npx` the command search path finds: it
assumes that program behaves as npm's own, as the version-manager and package-firewall shims that
hand over to npm do.

### Reading secrets and instances

Every hard denial still applies first. Reading a declared instance or anything under a `.secrets`
directory is denied under every spelling that resolves to it, including a case-folded spelling of
the checkout itself, and so is a recursive search rooted at or below one. Shell reads also compare
filesystem identity: a hard link to a declared instance, or to any file in the cockpit's
`env/.secrets` directory, is denied like the file itself. The guard enumerates that directory on
every call, up to 512 entries; above that bound every content read falls back to a prompt rather
than going unchecked. A hard link to a file in any other `.secrets` directory is recognised only by
its spelling.

These reads fall back to a prompt instead of being allowed:

- a recursive search, whenever a declared instance or an `env/.secrets` file has a second hard link
  anywhere;
- a search whose tree contains an existing instance or the secrets directory, since the guard cannot
  see which files the search would read (ripgrep's hidden-file filter yields to an ignore file the
  agent can write). The reason names that path, so the agent can search a narrower one. A tree that
  would contain one that does not exist yet is searched only when every other command in the call
  is read-only too, so nothing in the call can create it first;
- a path that is a symlink, lies outside the configured roots, or is an undeclared `.env*` file. A
  declared environment `template` is read like any other file.

The guard hook sees shell commands and edits only. Claude Code's own Read, Grep and Glob tools never
reach it, so `sync` also writes Claude `Read` deny rules into `.claude/settings.json`: one for every
`.secrets` directory and one for every declared instance of every sibling, whether or not the
sibling is mounted or granted to Claude. A sibling instance's rule is anchored on the path below the
sibling's parent, so the committed file is identical on every clone; it can match more than the
instance (any file with the same sibling-relative suffix), never less. An instance in the cockpit
root itself is anchored at the project root. These rules match path spellings only: Claude's native
tools cannot see filesystem identity, so a hard link or a symbolic link to an instance or secrets
file, under a name outside the rules, stays readable to them. The guard's identity checks cover
shell commands only.

## Native adapter behavior

The [transport and adapter owner](../packages/cockpit/src/guards/harness-adapter.ts) translates a
decision without adding grants or weakening hard boundaries:

| Harness | Translation and adapter exit |
| --- | --- |
| Claude Code | Allow, ask, and deny exit 0; ask and deny are carried in native decision JSON. |
| Codex CLI | Ask becomes deny, because Codex hooks have no prompt tier, and a decision a human cannot be shown must not let the call run. Allow and deny exit 0; deny is carried in native decision JSON. |
| OpenCode | Ask becomes deny, for the same reason: its plugin hook can only throw or continue. Allow exits 0; every non-allow decision exits 2. |

Unavailable or malformed decisions exit 2 on every target, so adapter exit 0 alone does not mean
permission was granted.

Guard transport uses a fixed handler argument vector, normalized absolute handler and
working-directory paths, bounded standard input, and bounded output and error. The
[transport owner](../packages/cockpit/src/guards/harness-adapter.ts) sets a timeout so a stalled
handler cannot hold a guarded call indefinitely. Copied plans, failed transport, signals, oversized
output, nonzero handler status and invalid JSON become `unavailable` with exit 2. Lexical path
normalization in this adapter does not itself verify filesystem identity.

If an adapter is unavailable, no target-specific registration or read-only fragment is emitted; the
shared guard file may still be generated. What each harness is confirmed to enforce, and why
generated restrictions stay `instructed` until a run of the real tool says otherwise, is in
[Capability states](harness-surfaces.md#capability-states) and
[Guard adapters](harness-surfaces.md#guard-adapters).

## Exit codes and generated references

Exit codes are listed in the [CLI reference](cli-reference.md). How cockpit records command
completion and keeps its generated reference pages current is maintainer detail, in the contributor
page "CLI completion and generated references", reached from [CONTRIBUTING.md](../CONTRIBUTING.md).

## Evidence

Static configuration, source inspection, synthetic fixtures, model self-report and silence do not
prove native enforcement. The
[native evidence validator](../packages/cockpit/libexec/validate-harness-evidence.mjs) binds exact
current executable and wiring identities, generated-manifest and candidate digests, version,
bounded transcripts and validation results, and each record carries candidate and deliberately
broken-control evidence.

Missing evidence keeps a cell `instructed` or `unavailable`, with `human_needed` judgments still
pending. It never relaxes a hard denial or grants a permission. Switching defaults, deleting
fallbacks and publishing stay human decisions; a green source check or a generated reference does
not make them.
