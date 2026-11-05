# Safety and autonomy

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
The command after `session --` or `exec --` is judged as one more invocation, so neither admits
what the guard would refuse on its own. `exec` runs it in a product container whose files the
guard cannot see, so a read-only proof about host paths does not carry over: the name-based
denials (`.env*` and the rest) still apply to it, and it is admitted only by a `[guards] allow`
rule or as a declared build or test command; otherwise it asks, which Codex and OpenCode turn into
a denial. Declared project build and test commands are allowed only as their exact argument vectors in their
own checkout. A wildcard over a command family never grants permission.

## Hard controls and prompts

Evaluation runs in this order: built-in hard denials, declared denials, checks cockpit could not
complete, declared allows, the built-in read-only profile, then `ask`. A declared allow therefore
cannot bypass any boundary below.

### Instances, secrets and hosted endpoints

The guard denies mutation or staging of a declared environment instance, and mutation below a
secrets directory. That covers command and patch removals as well as writes, removing a directory
that contains an instance or the secrets directory, and staging a containing directory that could
include an instance or a secrets directory.

Every `.env` and `.env.*` file at any depth is treated as holding secrets, declared or not: reading,
writing, removing, staging or linking one is a hard denial through every guarded tool. The
conventional documentation names `.env.example`, `.env.sample`, `.env.template` and `.env.schema`
are exempt from the guard, and so is every declared environment `template`; native permissions may
still refuse these documentation files (see [Reading secrets and instances](#reading-secrets-and-instances)). Run a trusted
process instead of reading values: an agent uses a declared project command or script that wraps
Varlock, because the guard asks about a bare `varlock run` and Codex and OpenCode refuse what it asks
about. A person in a terminal runs that same command, or
`VARLOCK_TELEMETRY_DISABLED=true varlock run -- <cmd>`, without `--redact-stdout`: Varlock refuses to
force redaction on an interactive terminal, so the flag belongs inside a declared command whose output
is piped. Redaction is an output safeguard, not confinement of the child process. Another name
that starts with `.env`, such as `.envrc`, is not denied, but reading it prompts.

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
after `sync` runs, and only a person's sync applies an edit that
[widens what agents may do](#edits-the-guard-has-not-applied).

Writing anywhere under a `.git` directory is a hard denial, because Git configuration chooses
programs that read-only Git commands run. For the same reason, so is every `git config` form other
than a proven read (`--get`, `--get-all`, `--get-regexp`, `--list`, `get`, `list`, or a lone
`section.key`), whatever its scope: a global `core.pager` or `core.hooksPath` reaches every
repository.

Removing, renaming or directly overwriting a guard control is a hard denial, as is removing a
directory that contains one or an executable control below a protected plugin directory. Otherwise
an exact command allow could disable a hook, or change a program a harness starts, before the next
guarded call. The protected files include every harness's native MCP and permission outputs derived
from the shipped harness registry, the MCP wrapper scripts under `.cockpit/mcp/` that those
outputs start, the work-order records under `.cockpit/work-orders/`, which carry no key, so one an
agent wrote would read as a person's to the next `cockpit work` command, and `.cockpit/policy.json`,
the [autonomy policy](#who-decides) the last sync accepted. This boundary follows folded path
spellings and verified filesystem identities, so alternate case and aliases do not bypass it.

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

Only absolute search path entries can be protected: a relative entry such as `.`, `./node_modules/.bin`
or an empty one names whatever directory a command runs in, so a file the agent wrote anywhere could
run in place of a permitted command, or as the interpreter a path-spelled script such as
`./node_modules/.bin/cockpit` starts through `#!/usr/bin/env node`. While the harness's `PATH` holds
one, no command is allowed without a prompt, whatever profile or declared rule matches it, and the
reason names the entry. Keep relative entries off the `PATH` an agent harness starts with; `doctor`
reports one in the `PATH` it runs with as `GUARD_SEARCH_PATH_RELATIVE`.

That warning describes the CLI process, not a measurement of a running harness's environment: a
wrapper that injects a relative bin directory, such as a package manager's, produces it for the
command it starts. An injected relative entry is the shape these checks were measured against; the
pnpm release tested put an absolute directory first under `pnpm exec`, and `doctor` gave no relative
warning there, so do not read the warning as coming from pnpm. Check the shell or launcher that
starts the harness before changing its configuration. For their own Git and Docker observations, `doctor`,
`preflight`, `check` and `docs check` use only the absolute directories already on `PATH`, in their
original order. Every relative entry is excluded, including empty entries, `.` and paths starting
with `..`, so changing into a sibling cannot select a different tool. `up` and the other commands
that start or change a stack keep their strict search and refuse, stating the reason. A noncanonical
absolute entry, such as `/usr/bin/../bin`, still refuses the observation, and with it `sync` and
`check` wherever they have Git to ask or Compose to read; no entry is normalized. Put the required
tool in a canonical absolute directory and rerun the command. Git simply missing from `PATH` does
not refuse a cockpit that declares no runtime: see [Environment modes](environment.md#environment-modes). This does
not change the environment used to start sessions, discover evaluators or check MCP commands, or the
guard's approval rules. A completed observation does not establish that a harness runs its generated
hooks or that an external integration works.

Generated checkout identity and native-hook revision observations use the same absolute-only
Git search during `sync` and `check`. Publication authorization and the native hook's execution
environment retain their existing rules.

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

These are `unavailable`: every unsupported `tar` or `ln` mode or option, and a command whose
visible operand names a control, a protected plugin subtree or a directory containing either
and that the guard cannot classify. These checks run before declared allows. They do not inspect archive
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
staging by explicit path (a person approves or runs it), staging without explicit paths, wrapped or environment-modifying commands, unmatched invocation
profiles, and any removal without a grant. An explicit removal outside configured roots stays at
`ask` even when a declared allow matches, because cockpit cannot verify a target outside the roots
it manages; review the exact path and approve it, or move the work under a configured root. `git add -A`, `git add .` or a
directory operand that covers a secrets directory at any depth or an environment instance is a hard
denial: stage the changed files by name. The guard walks the operand to find nested secrets
directories; a tree past the walk's bound stays at `ask`, and a walk that fails is `unavailable`. Unsupported staging options or unproven pathspec grammar produce
`unavailable`. Any other refused command gets an `ask` that names the command and gives three ways
forward: a person approves it, a person runs it in a terminal, or a person admits it under
`[guards] allow`; for tests it points to `cockpit test-run`.

### Declared rules

Declared rules refine the final prompt boundary. Each vector starts with the executable.
`[[guards.deny]]` matches a command-vector prefix or a contiguous command-vector sequence and may
name a safe fix. `[[guards.allow]]` matches a command-vector prefix, optionally only at one
checkout-relative working directory. An allow cannot bypass a hosted endpoint, protected branch,
secret path, malformed capture or unavailable filesystem evidence. Wrapped and
environment-modifying invocations are never allowed by a declared rule, because wrappers can change
which program actually runs. A rule that admits an interpreter, such as `["node"]`, `["python3"]` or
`["perl"]`, admits whatever code it is given, inline (`node -e`) or in a file, and the guard cannot
see what that code writes, guard controls included; without such a rule those invocations ask.

Malformed or oversized input, incomplete policy, escaped or symlinked path evidence, inspection
failure and exceeded limits produce `unavailable`. The
[invocation parser](../packages/cockpit/src/guards/invocation-parser.ts) captures bounded input
once; the evaluator accepts only input that parser produced, so a hand-built lookalike is refused.

### Read-only commands

A built-in read-only profile lets agents inspect the checkout without a prompt, which matters most
on Codex and OpenCode, where a prompt becomes a denial. It covers exact argument shapes of `ls`,
`pwd`, `cat`, `head`, `tail`, `wc`, `rg`, `grep`, `fd`, `find`, `echo`, `printf`, `sed`,
`git status`, `git diff`, `git log`, `git show`, `git rev-parse`, `git branch` listing flags, and the
cockpit commands in
[Cockpit commands an agent can run](#cockpit-commands-an-agent-can-run). The
[read-only profile](../packages/cockpit/src/guards/read-only.ts) lists each permitted option.

- Any other option falls back to the ordinary rules, including options that run programs or write
  files: `rg --pre`, `find -exec`, `find -delete`, `fd --exec`, `git -c`, `git --output`,
  `git --ext-diff` and `git diff --no-index`.
- Options whose value is optional, such as `grep --context` on macOS, are accepted only in their
  attached `--option=value` form, so the next word can never be misread.
- `printf` is read-only only without options, because `printf -v` assigns a variable. `sed` only
  prints: `sed -n '5p'` or `sed -n '1,$p'` with numeric or `$` addresses and the `p` command, since
  other commands can write or run programs. `git rev-parse` is read-only except `--git-path`,
  `--resolve-git-dir`, `--parseopt` and `--sq-quote`. `git branch` is read-only with no argument or
  with `--list`, `-a`, `-r`, `-v`, `-vv` or `--show-current` (and their long forms), never with a
  branch name.
- `$?` is allowed as an argument only to a read-only command, where it cannot name a path, and
  never as the directory of `env -C`.
- A command may follow `cd ./dir`, `cd ../dir` or `cd /abs/dir` joined by `&&` or `;`, with the
  directory then judged as the command's working directory. A bare `cd name` is refused, because
  `CDPATH` can send it elsewhere the guard cannot see: write `cd ./name`, or use `git -C name` for
  Git. A `..` after a directory name, as in `cd ./a/../b` or `env -C a/..`, is refused too: `env`
  resolves it from wherever a link named `a` leads, and so does a shell set to follow links.
  `pushd`, `popd` and zsh's `chdir` are refused, because only `cd` is followed. A `cd`
  may fail, and one after `||` may not run at all, so each later command is judged from every
  directory it may run in: `&&` and `||` group left to right, so in `pwd || cd ./dir && cat x` the
  `cat` is judged from both directories. A newline after `&&`, `||` or `|` continues the list. A
  `cd` in a pipeline is refused, and a list ending in `&` runs in a subshell, so its `cd` moves no
  later command.
- Git runs read-only only in a directory with its own `.git`, because Git otherwise treats a
  directory holding `HEAD`, `objects` and `refs` as a repository and honours its configuration.
  Git operands are inspected as files whose content may be printed.
- `rg` is read-only only when `RIPGREP_CONFIG_PATH` is absent, because an ambient ripgrep
  configuration can inject options such as a preprocessor. Its `-g`, `--glob` and `--iglob` are
  read-only only as `!` exclusions: any other glob overrides the hidden and ignore filters, so
  `rg -g '.env*'` would print a hidden environment file.
- A pipeline or chain is permitted only when every segment is. Redirecting output to `/dev/null`,
  `/dev/stdout` or `/dev/stderr`, or input from `/dev/null`, touches no file and does not change the
  decision.

### Cockpit commands an agent can run

| Command | Decision | Why |
| --- | --- | --- |
| `npx --no cockpit check --config cockpit.toml`, and likewise `doctor`, `preflight`, `ps`, `logs --service <service>`, `stacks`, `stacks prune`, `docs check` and `sync --dry-run` | allowed | They read and report; nothing they do changes a file the guard relies on. |
| `npx --no -- cockpit --help`, `npx --no cockpit up --help`, and the version | allowed | They print and exit before any command runs. |
| `npx --no cockpit up --config cockpit.toml`, and likewise `sleep`, `down`, `restart --service <service>` and `rebuild --service <service>` | allowed | They act only on the stack cockpit declared and owns; `down` keeps data volumes, and deletes only from the local Docker daemon it fixes at the start of the run. |
| `up --profile <profile>` | allowed for a profile in `environment.profiles` that mounts no sibling with `gate = "operator"`, otherwise a prompt | Another profile starts services no person declared for agents, and an operator-gated sibling touches live data or local hardware. |
| `npx --no cockpit exec --config cockpit.toml --service <service> -- <command>` | allowed when a `[guards] allow` rule or a declared build or test command admits `<command>`, otherwise a prompt | The command runs in a container whose files the guard cannot see, so it is never proven read-only, and the name-based denials still apply to it. |
| `npx --no cockpit pull --config cockpit.toml` | allowed | It only fetches and fast-forwards, and leaves a modified or diverged checkout as it was. |
| `npx --no cockpit use <slug> <checkout> --config cockpit.toml`, and `use <slug> --clear` | allowed for a checkout inside a directory the agent may already write, otherwise a prompt | The choice is recorded for this checkout of the cockpit only, so it never widens what the agent can reach. |
| `npx --no cockpit runtime measure --config cockpit.toml --image <local-image>` | allowed | The probe runs a disposable stack under its own project, removes it, and records the result only in this machine's git-ignored state; `cockpit.toml` never changes. |
| `npx --no cockpit session --config cockpit.toml -- <command>`, with a `--profile` that `up` admits | the decision for `<command>` | A session runs its command as the agent could run it directly, so it never admits more. |
| `npx --no cockpit test-run --config cockpit.toml --gate <gate>`, with an optional `--mode` and a `--select <kind>:<value>` whose value does not start with `-` | allowed for a gate `cockpit.toml` declares | The gate runs only the stages a person declared in the reviewed configuration, the trust `up` already has. |
| `npx --no cockpit work status --config cockpit.toml`, `work accept`, `work check`, `work note`, `work decide`, `work answer`, `work acknowledge`, `work grade`, `work signoff`, `work recover` (with or without `--apply`), `work verify` and `cockpit grade --criteria <file>`, each with its own options | allowed | They report, or take a step [`[work.gates]`](#who-decides) gives the agent; a step it gives a person waits for the digest typed after `--interactive`, which no agent invocation carries. Grading runs in a separate evaluator. `work recover --apply` removes a lock only once it has shown the holder gone on the lock's own host and among the containers cockpit labels. |
| `npx --no cockpit sync --config cockpit.toml`, and `upgrade`, whose sync child writes | allowed where `[autonomy] sync = "agent"`, otherwise a prompt | It regenerates the files the configuration declares; after `cockpit.toml` changes, the guard admits it only when the edit [does not widen](#edits-the-guard-has-not-applied) what agents may do, so an agent's sync never publishes a widening of its own. |
| `npx --no cockpit tool add <tool> --config cockpit.toml`, with an optional `--dry-run` | allowed | It edits only `[surfaces] tools`, and an added tool [does not widen](#edits-the-guard-has-not-applied) what agents may do, so the agent's sync applies it. |
| `npx --no cockpit reset --config cockpit.toml --apply` | allowed where `[autonomy] reset = "agent"`, otherwise a prompt | It deletes stack data. |
| `npx --no cockpit stacks prune --config cockpit.toml --apply` | allowed; the command itself refuses a prune that deletes volumes unless `[autonomy] reset = "agent"` | It removes only stacks whose checkout is gone, which bringing the stack up again recreates, and their data only where a reset could delete it. |
| `npx --no cockpit browser drive --config cockpit.toml`, and likewise `screenshot`, with an optional `--role` | allowed where `browser.request_preapproval` is on, otherwise a prompt | They sign in and capture the declared application, so they run unprompted only on the isolated, non-production data the configuration declares. Preapproval is on by default exactly when `browser.data` is isolated, not restored and not reaching production, and off otherwise; an explicit `request_preapproval` wins, and `true` on a posture that does not qualify is refused. `drive` also accepts `--fail-on-findings`. |
| `work accept`, `work answer`, `work acknowledge` and `work signoff` with `--interactive` | a prompt, which Codex and OpenCode turn into a denial | `--interactive` asks for a person at a terminal to type the digest of what it shows. |
| `sync --adopt`, `sync --interactive`, `reset --interactive`, `stacks prune --interactive`, `sibling add`, `sibling remove`, `tool remove` and every other command | a prompt, which Codex and OpenCode turn into a denial | They widen what agents may do through `cockpit.toml`, rewrite a team's own settings, ask for a person, or delete data. |

A file such a command names, like `--criteria`, is checked as a read:
the command may quote it in a refusal. A declared instance, a file below `.secrets` or a `.env` or
`.env.*` file that is not documentation is denied, and a symlink or a path outside the configured
roots prompts.

"Allowed" means the guard does not object. Claude Code also needs its own allow rule, which the
generated settings carry for the commands the shipped skills use
([Claude Code command rules](harness-surfaces.md#claude-code-command-rules)); in Codex's sandbox
most of these commands must run outside it
([Run cockpit outside the Codex sandbox](harness-surfaces.md#run-cockpit-outside-the-codex-sandbox)).

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

Where npx cannot be proven, every npx spelling prompts, and Codex and OpenCode refuse it, while the
same command spelled as a path, such as `./node_modules/.bin/cockpit doctor --config cockpit.toml`,
still counts from the cockpit root. pnpm writes `node_modules/.bin/cockpit` as a shell shim, which
neither npx nor a path check can follow, so there the provable spelling is the package's own script:
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml`.
`doctor` reports this as `COCKPIT_LAUNCHER_UNPROVEN`, using the guard's own check, and names which
spelling it can prove. The guard does not check which `npx` the command search path finds: it
assumes that program behaves as npm's own, as the version-manager and package-firewall shims that
hand over to npm do.

### Reading secrets and instances

Every hard denial still applies first. Reading a declared instance, a `.env` or `.env.*` file that
is not documentation, or anything under a `.secrets` directory is denied under every spelling that resolves to it, including a case-folded spelling of
the checkout itself, and so is a recursive search rooted at or below one. Shell reads also compare
filesystem identity: a hard link to a declared instance, or to any file in the cockpit's
`env/.secrets` directory, is denied like the file itself. The guard enumerates that directory on
every call, up to 512 entries; above that bound every content read falls back to a prompt rather
than going unchecked. A hard link to a file in any other `.secrets` directory is recognised only by
its spelling.

These reads fall back to a prompt instead of being allowed:

- a recursive search, whenever a declared instance or an `env/.secrets` file has a second hard link
  anywhere;
- a search whose tree contains an existing instance, a `.secrets` directory at any depth, or a
  `.env*` file that is neither a declared template nor one of the documentation names, since `grep -r` reads every file below it. The guard
  walks each searched tree to find them, without following links, and a tree too large for its
  bounded walk is not searched either. The reason names the path, so the agent can search a
  narrower one;
- an `rg` search that would read one. ripgrep skips what Git ignores, so the guard asks Git, with
  the guard's own Git executable, which files the enclosing repository does not ignore, and a
  gitignored `.env` or `node_modules` does not block it. Only `.gitignore` files are applied, and
  hidden files count, because a type such as `rg -t sh` reads a `.env`. Where Git's list cannot stand
  for ripgrep's (outside a repository, with an `.ignore` or `.rgignore` file in or above the tree,
  through a nested repository or submodule, below a `.git` or `.jj` entry, above which ripgrep stops
  applying ignore files, when the search names an ignored path, when a `.gitignore` Git reads holds
  a line the two glob engines may read differently, such as braces, a POSIX class like `[[:alpha:]]`,
  a backslash escape, trailing whitespace, a `**` that is not a whole path component, or bytes that
  are not UTF-8, or when Git does not answer), the
  search is walked like `grep -r`. Either way the guard sees only what exists before the call runs, so a
  recursive search is allowed only when every other command in the call is read-only too, and
  nothing in it can write an environment file first;
- `git diff`, `git show`, and `git log` with patch output, whenever the repository's index holds a
  `.env*` file that is neither a declared template nor a documentation name, a file below a
  `.secrets` directory or a declared instance, unless the command names no revision and is limited with `-- <path>` to paths that hold
  none (`git log` may name revisions, but not `--full-diff`). `--check` counts as printing content,
  and `git log -L<range>:<path>` is not read-only. A revision may name a blob, which prints whatever pathspec
  follows. Only the index is asked: a file committed once and since removed from it is still in
  history, and `git log -p` prints it. Run `git rm --cached` and rotate what it held;
- a path that is a symlink or leaves one through `..`, lies outside the configured roots, or has
  another `.env*` name, such as `.envrc`. A declared environment `template` and the documentation
  names are read like any other file.

The guard hook sees shell commands and edits only. Claude Code's own Read, Grep and Glob tools never
reach it, so `sync` also writes Claude `Read` deny rules into `.claude/settings.json`: one for every
`.env` and every `.env.*` file, one for every `.secrets` directory and one for every declared instance
of every sibling, whether or not the
sibling is mounted or granted to Claude. A sibling instance's rule is anchored on the path below the
sibling's parent, so the committed file is identical on every clone; it can match more than the
instance (any file with the same sibling-relative suffix), never less. An instance in the cockpit
root itself is anchored at the project root. In the native probe below, Claude refused a symbolic
link whose target was protected. A hard link under a name outside the rules is not covered by these
path rules; the guard's filesystem identity checks cover shell commands only.

| Native read measurement | Observed result |
| --- | --- |
| Claude Code 2.1.318, macOS, 2026-11-05 | Ordinary Read succeeded; Read through an unmatched-name symlink to a synthetic `.env.private` was refused. Explicit `Bash(cat *)` permission let `cat ordinary.txt` run, while `cat .env.schema` was refused. |

Claude's filesystem-root deny rules cannot exempt the documentation names:
native file tools and recognized shell reads such as `cat` also refuse `.env.example`, `.env.sample`,
`.env.schema`, `.env.template` and declared templates with a `.env.*` name. A guard approval does not
override that native denial. Claude's ordered negation exceptions apply only to relative rules;
using those here would leave sibling secrets outside the protection. See
[Claude's permission rules](https://code.claude.com/docs/en/permissions#read-and-edit).

## Who decides

`[autonomy]` and `[work.gates]` in `cockpit.toml` say who takes each decision cockpit gates: `agent`,
`person` or `ci`. Every field defaults to `agent` except `reset` and `mcp_approve`, which default to `person`.
`[work] grading` says how a work order earns done; the work-order fields are described in
[Who passes each gate](work-and-browser.md#who-passes-each-gate).

| Field | Decides | Default |
| --- | --- | --- |
| `sync` | whether the guard lets an agent run a writing `sync`; under `ci` a writing sync runs only where `CI` is set | `agent` |
| `stale_delete` | whether `sync` removes a file it generated before and no longer generates without a person typing the stale-removal digest; an unchanged MCP-only file of a listed tool whose servers are no longer written never waits, because removing it only narrows access | `agent` |
| `reset` | whether `reset --apply`, and a `stacks prune --apply` that deletes volumes, delete stack data without a person; otherwise a person approves the preview with `--interactive` | `person` |
| `mcp_approve` | `person`: sync enables only the MCP servers whose digest a person recorded in `[mcp.approved]`, and `MCP_NOT_APPROVED` names the rest; `agent`: sync enables every declared server as declared now, which lets an agent start processes outside the guard, because a sibling's MCP source is a file the agent can write and each harness starts an enabled server outside every guard boundary | `person` |

<!-- cockpit:ref path=packages/cockpit/src/guards/policy-pin.ts --> The guard pins the policy: an agent's edit, write or patch that would change `[work]`,
`[work.gates]` or `[autonomy]`, or widens MCP tool access, is a hard denial. MCP server approvals
are also pinned while `mcp_approve` is `person`; delegating server approval does not delegate
permission to remove tool restrictions.
Removing unchanged MCP approvals and adding or narrowing exact tool allowlists is permitted:
disabling a server or restricting its tools grants no new access. The guard
applies the edit to the current text and compares the tables, so an edit elsewhere in the file stays
permitted; an edit it cannot apply exactly, and a shell command that names the file and is not a
proven read, a Git record or the `--config` operand of a cockpit command, are denied because the guard
cannot prove the change preserves gate authority and grants no new MCP access. A cockpit session's command after `--` is judged as a command of its
own, and a path or `node <script>` spelling of cockpit is admitted only where the guard proves it
starts the installed cockpit. The pin holds only for the
tool calls the guard inspects.

Every writing `sync` records the policy it ran under in `.cockpit/policy.json`. A later sync that finds
a field weaker than that record, such as a gate moved from `person` to `agent` or grading from
`independent` to `self`, writes nothing and reports `POLICY_WEAKENING_UNCONFIRMED` with the change and
its digest; a person runs `sync --interactive`, reads it and types the digest. `check` and `doctor` report
the same weakening before any sync runs. Until then every work
command refuses to run under the weaker policy, and so does `reset --apply` when `[autonomy] reset` is
the weakened field. A stronger policy needs nobody.

What no setting relaxes: reads of secrets and declared instances, pushes to protected branches,
writes to guard controls, and the policy pin. What only a person can do: trust Codex's hooks, trust a
workspace in Claude Code, and sign in to a secrets provider. `doctor` and `check` report missing
Codex hook trust as `CODEX_HOOK_UNTRUSTED`; cockpit cannot observe the other two, so a person
confirms them.

A local `person` gate is best-effort: cockpit cannot tell a person from a program driving a terminal.
`ci` relies on the `CI` variable, which an agent can set too, so locally it is best-effort as well.
The only enforced human gate is a required CI job behind a protected environment whose reviewers must
approve it, such as the [`work verify` job](work-and-browser.md#who-passes-each-gate).

### Edits the guard has not applied

<!-- cockpit:ref path=packages/cockpit/src/guards/policy-change.ts --> Once `cockpit.toml` differs
from the configuration the guards were generated from, the guard loads both, the earlier from the
copy sync keeps in `.cockpit/local/guard-config`, and compares them with defaults applied. An edit that does
not widen what agents may do holds every guarded call except `cockpit sync` and `cockpit check`, which
the agent may run under the rules above, and the hold says so (`GUARD_CONFIG_UNSYNCED`). Any other
edit holds every guarded call, that sync included, until a person runs `sync` in a terminal, and the
hold names each field that widens.

A guarded call is one a generated hook fires on: shell commands, file edits and writes, and restricted
MCP tools under Claude Code. A hold stops nothing else, so file reads and unrestricted MCP tools continue.

Sync can refuse an edit the guard admitted, such as a tool restriction naming an undeclared server.
So the `GUARD_CONFIG_UNSYNCED` hold also admits one edit, write or patch of `cockpit.toml` itself that
leaves it byte-identical to the recorded copy, because restoring that copy cannot widen anything. An
edit the guard cannot prove applies exactly once, or that also touches another file, stays held.

An edit does not widen only when every difference is one of these:

- descriptive or host-only fields: a sibling's `purpose`, `host_reason` and `rebuild_inputs`,
  `cockpit.guide_cap`, `[ports]`, `environment.entrypoint_derivatives`, `environment.machine` and
  `docs.living`;
- added agent tools, `unconfirmed` answers and sibling operator gates;
- removed Compose files, Compose profiles and resettable volumes, and an install policy that admits no
  command it did not;
- removed guard allow rules and unchanged MCP approvals, added or narrowed MCP tool allowlists;
  added guard deny rules, protected branches,
  hosted database hosts and vendor endpoint hosts;
- any change to `[mcp.approved]` while `mcp_approve = "agent"` in both configurations, because that
  setting already hands server approval to the agent.

Every other difference widens. That includes any change, in either direction, to
`[work]`, `[autonomy]`, `[testing]` (whose stages `test-run` runs unprompted) and `[browser]`;
new or changed MCP approvals outside that delegation, removed or expanded MCP tool allowlists, new guard allows or removed guard restrictions; a new sibling, wherever its directory is; a sibling's changed `dir`, `guides` (sync copies each guide
into the root `AGENTS.md`), environment files or derived MCP sources; and every command field, such
as `environment.seed`. A field the classification has no rule for widens too, so a field added to
the schema is a person's decision until a rule says otherwise. A missing or mismatched
copy of the generated configuration cannot show an edit safe, so it holds as a widening edit does.
`check` reports the same classification: `GUARD_CONFIG_UNSYNCED` as a warning, `GUARD_CONFIG_WIDENED`
as an error naming the fields.

Whoever runs it, sync refuses a guide that is, or links to, a `.env` or `.env.*` file, a file below a
`.secrets` directory or a declared environment instance (`PROJECTION_GUIDE_SECRET`), so a guide never
copies what the guard keeps from agents into the root `AGENTS.md`.

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
