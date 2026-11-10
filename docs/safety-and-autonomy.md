# Safety and autonomy

What the guard allows, asks about, denies or cannot evaluate, and why. The
[command table](../packages/cockpit/src/command-table.ts) and
[guard evaluator](../packages/cockpit/src/guards/evaluator.ts) own these decisions.

## The default: known tools, except the blocked list

By default (`[guards] default = "allow"`) the guard allows a command when its executable is a
development tool it knows, and judges each one by that tool's own rules. The known tools are Git and
`gh`; package managers and the programs they launch (`npm`, `pnpm`, `yarn`, `bun`, `npx`, `uv`, `pip`);
interpreters running project files (`node`, `python3`, `ruby`) and build and test tools (`make`,
`cargo`, `go`, `tsc`, `vitest`, `pytest`); formatters, linters and runners for other languages
(`gofmt`, `golangci-lint`, `shellcheck`, `rspec`, `rake`, `pre-commit`, and `bundle exec`, which is followed to the
program it runs); `docker` for its read-only queries only (`image ls`, `images`, `ps`, `container ls`, `version`, and
`image inspect` with a `--format` template that reads only the image's identity, never `.Config` or `Env`; a global option such as `-H` or
`--context`, a `DOCKER_*` variable set or exported anywhere in the call, `container inspect`, `exec`, `run`, `compose` and every other subcommand ask); `rustup`, for its read verbs only; `lsof`, `pkill` and `kill`, which signals a
process id of 2 or more or a `%job`, never every process or a process group; shells; read and text
utilities (`cat`, `rg`, `find`, `jq`, `awk`, `sed`); file utilities, judged as writes inside the roots
(`mkdir`, `cp`, `mv`, `rm`, `tee`); archive and sync tools (`tar`, `zip`, `rsync`); `curl` and `wget`;
and cockpit's own CLI. The `KNOWN_TOOLS` set in the
[evaluator](../packages/cockpit/src/guards/evaluator.ts) is the list. Two more kinds run: a project
program spelled as a path inside the roots (`./scripts/build.sh`), and a package script run by a bare
package-manager command (`pnpm build`, `yarn lint`, `bun run test`). A word after `pnpm` or `bun run`
counts as a script only where the nearest `package.json` declares one of that name (`bun run` of a
`.js` or `.ts` file inside the roots counts too); any other word is judged as the program it names, so
`pnpm kubectl get pods` asks as `kubectl` does. With `-r` or `--filter` a script also counts when the
workspace root or any workspace package declares it, read from `pnpm-workspace.yaml` or a
`package.json` `workspaces` list; a workspace the guard cannot read within its bounds counts no
script, so the word asks. `exec`, `dlx` and `x` name a program, not a script. A known tool given a directory that merely holds a guard control, as in
`npx prettier --write .` at the cockpit root, is allowed; naming a control itself, or a Git pathspec
that matches one, is still held. In practice an agent works freely inside the cockpit and its siblings: Git work
such as `add`, `commit`, `merge`, `rebase`, `switch`, `stash`, `fetch`, `pull` and pushes to work
branches, builds, tests, package scripts, `gh` queries and pull requests.

Two kinds of command ask instead. A program the guard does not know (`kubectl`, `ssh`, `docker`
beyond its read-only listings, `psql`, `perl`, an unlisted tool fetched by `npx`) asks, and so does inline code the guard cannot read:

- an interpreter's `-c` or `-e`, including after option values (`python3 -X utf8 -c`,
  `node -r ./x.js -e`), and `deno eval`;
- a `--require`, `--import` or `--loader` given a data or remote URL;
- an interpreter run with no script, or with `-`, so that it reads standard input from a heredoc or a
  pipe;
- `find -exec`, `make --eval`, `-E` or `-f -`, and `go` with `-exec`, `-toolexec` or `-vettool`;
- `rsync -e`, `scp -S`, `-F` or an `-o` option that names a command, and `zip -TT` or
  `--unzip-command`;
- an `awk` program that calls `system`, reads with `getline`, or sends `print` or `printf` to `>`, `>>`
  or a pipe;
- a `sed` script with the `e` or `w` command.

The reason begins "`<command>` is not a development tool the guard knows, or runs inline code it
cannot judge". In Claude Code an ask is a permission prompt. Codex and OpenCode hooks cannot prompt,
so there it is a refusal. A person approves the command or runs it in a terminal, or admits the
program for good with a `[[guards.allow]]` rule and syncs; an agent proposes the rule rather than
writing it.

Two asks stay by design. `docker compose` (`up`, `logs`, `ps`, `down` and the rest) asks, and the
reason points to `cockpit up`, `logs` and `ps`, because Compose services can mount any host path the
guard cannot judge. `psql` asks as an unknown program: its `\!`, `\o` and `\copy` meta-commands run
shell commands and write files.

The blocked list below is refused in every mode, and no `[[guards.allow]]` rule overrides it. Where a row says a case asks, no rule admits that case either:

| Blocked | What the guard checks |
| --- | --- |
| Secrets | A command that names an `.env*` file (other than documentation names and declared templates), a `.secrets` directory, a declared instance or a credential store: in its arguments (including `--body-file`, `-T` and `@file` values), an input or output redirect, a link source, an assignment value, a loop item, an unexpanded glob that can match one, or a file tool's path. Any known tool given such a name is refused, whether it reads, prints, copies or sends the file (`sort`, `xxd`, `awk`, `curl -T`, `gh gist create`); only a program the guard does not know, such as `docker compose --env-file .env up`, asks, because it may only pass the name on. Credential stores are the files and directories below the home directory that hold tokens and keys, such as `~/.ssh`, `~/.aws`, `~/.gnupg`, `~/.config/gh/hosts.yml`, `~/.netrc`, `~/.npmrc`, `~/.pgpass`, `~/.docker/config.json`, `~/.kube/config` and `~/.codex/auth.json`, the logins of other agent tools and deployment CLIs (opencode's `auth.json`, `~/.claude.json`, GitHub Copilot's `~/.config/github-copilot`, Vercel, including `~/.vercel`, Wrangler, Stripe, Supabase, Fly, Netlify, including `~/.netlify`, Firebase, Heroku's `~/.heroku`, `sentry-cli`, `hub` and `doctl`; older locations a tool may no longer write are listed too), shell histories (`~/.zsh_history`, `~/.bash_history`, fish's history), any directory above them, and `.pem`, `.p12`, `.pfx`, `.key` and `id_*` key files anywhere; the [evaluator](../packages/cockpit/src/guards/evaluator.ts) holds the full list. Also refused: commands that print a credential without naming a file (`gh auth token`, `git credential`, `git remote -v` and `get-url`, `aws configure get` of a secret, `gcloud auth print-access-token`, `az account get-access-token`, `security find-generic-password -w`, `op read`, `git var -l`), environment dumps (`env`, `printenv`, `export -p`, `declare -x`, `set`, `ps e`, `npm run env` and its `yarn` and `pnpm` forms, `make -p`, an `awk` program that reads `ENVIRON`, and `declare -p` or `typeset -p` of a secret's name) and printing a variable whose name holds TOKEN, SECRET, KEY, PASS, PASSWORD, PAT or CREDENTIAL. |
| Writes outside the cockpit | Redirects, writer destinations (`cp`, `mv`, `tee`, `touch`, `mkdir`, `ln`, `dd`, `tar -x`, removers), write options (`--output`, `curl -o`, `wget -O`, `sort -o`, `sed -i`, `perl -i`; for `curl` also `-w '%output{file}'`, a `#N` output template with a URL glob, `-O`, `-J`, `--etag-save`, `--hsts`, `--alt-svc` and `--libcurl`; for `wget` the names it writes into the working directory or its `-P` directory, and its recursive forms; for decompressors the operand's name without its suffix; for `gh release download` and `gh run download` the `-D` directory, refused when the `-p` patterns could match a guard file there and asked when the names are unknown; and the directory `gh repo clone` and `gh gist clone` create), any operand outside the cockpit of `rsync`, `ditto`, `scp`, `unzip`, `patch`, `uniq`, `split` and similar writers, the new repository, worktree or bundle of `git clone`, `init`, `worktree add` and `bundle create`, and a working directory outside the cockpit and its siblings. Writing to `/dev/null`, `/dev/stdout` or `/dev/stderr` is exempt. Under the allow default any command that names a path outside the cockpit follows `[guards] external_reads`. |
| Branches and history | Force pushes of any branch (`--force`, `--force-with-lease`, a `+` refspec), pushes to a protected branch, remote branch deletion (`--delete`, `:branch`, `--prune`, `--mirror`), and rewriting a protected branch's history (`commit --amend`, `rebase`, `reset` to another commit, `update-ref HEAD`, `filter-branch`, `rebase <upstream> <protected>`, `rebase --onto <base> <upstream> <protected>`) or moving, resetting or deleting it, including `heads/<branch>` destinations, a fetch refspec into it (`git fetch . +topic:main`), `git send-pack` and GitHub API writes to a protected branch's ref. Force flags count when bundled or abbreviated (`-uf`, `--forc`). A push option the guard does not know asks. A push that names no destination is resolved from the repository's `@{push}`; one Git cannot resolve asks, and so does a push or rewrite that rests on the current branch after an earlier command in the same call that could move it. |
| Declared hosts | Any spelled use of a `hosted_db_hosts` or `vendor_endpoint_hosts` name. The match is lexical: a CLI with a built-in endpoint, such as `gh`, reaches its host without naming it. |
| The guard itself | Writes to hook registrations, `.cockpit/guards`, `.cockpit/local`, the installed cockpit, `node_modules/.bin` and `.npmrc`, including through glob or magic Git pathspecs and `--cacheinfo`; widening edits to `cockpit.toml`, which wait for a person's `sync`, and an agent's `sync` or `upgrade` while one waits; `node <copy>/dist/cli.js sync` or `upgrade` from a copy of cockpit inside the roots, which would make the guard run that copy; cockpit commands its own table does not admit (`sync --interactive`, `sync --adopt`, `sibling add` and the rest), however spelled (`npm run cockpit:sync`, `pnpm exec cockpit`, a path to `cockpit.mjs`), which ask and which no rule admits; direct `.git` writes; `git config` keys that choose a program (hooks, fsmonitor, pagers, editors, helpers, aliases, filters, drivers, includes, remotes, templates, submodules); `git -c` with such a key; `--no-verify` and its abbreviations; `pre-commit`, `husky` and `lefthook` `uninstall`; `git init` and `clone` with `--template`; transfer options that name a program (`--upload-pack`, `--receive-pack`, `--exec`); and assignments, prefixed or exported, that steer Git, its hooks or the command search path (`GIT_*`, `HOME`, `XDG_CONFIG_HOME`, `HUSKY`, `SKIP`, `LEFTHOOK`, a relative `PATH` entry, `set -a`). |
| Privilege and fetched code | `sudo`, `doas`, `su` and `pkexec`; a download piped into a shell or interpreter, such as `curl … \| sh`, `curl … \| awk` or `bash <(curl …)`; and a package launcher or `deno` given a URL or Git source. A program a launcher runs (`npx`, `pnpm exec`, `bun run`, `uvx`, `bundle exec`) is judged as if it ran on its own, and so is a `pnpm <word>` or `bun run <word>` that the nearest `package.json` does not declare as a script. Programs that run a command the guard cannot see (`script`, `flock`, `parallel`, `entr`, `xargs`, `eval`, `source`, `git rebase -x`, `git submodule foreach`, `git bisect run`) are refused. |
| Git updates to guard files | In a repository whose work tree holds guard controls, the secrets root or a declared instance, a Git verb that would write one of them from another revision: `merge`, `checkout` or `switch` to a revision, `reset --hard`, `--merge` or `--keep`, `cherry-pick`, `revert`, `rebase`, and `stash pop`, `apply` or `push`. Git compares the revisions before the command runs, and a verb that would change such a path is refused. A revision that does not resolve, or a Git that does not answer, asks. A plain `git pull` there asks, since what it brings arrives only as it runs: fetch first, then `git merge --ff-only <remote>/<branch>`. `git am` of a mail with an encoded body, or of a patch whose targets the guard cannot read, asks; a patch that names a guard control is refused. See [Git updates to guard files](#git-updates-to-guard-files). |
| Tool configuration | Writes to the person's own tool configuration and installs outside the cockpit: package-manager configuration writes (`npm`, `pnpm` and `yarn` `config set`, `delete` or `edit`), global installs, `npm link` and `yarn link`, `go install`, `go env -w`, `cargo install`, `uv tool install`, `pip install --user`, `pipx install`, `gh config set`, `gh alias set` and `gh extension install`. `npm config set --location=project` asks, because it writes the project's `.npmrc`. An install from a URL or a Git source asks, as `npx` does. |
| `gh` changes | Refused: `gh pr merge --admin`, `gh repo sync --force`, `gh repo delete`, and `gh repo edit` of the default branch, visibility or merge settings. Ask: any other `gh pr merge`, any other `gh repo edit`, and `gh repo rename`, `archive` and `unarchive`. Merging is a person's or CI's decision, and no `[work.gates]` entry covers it. |

Limits, stated plainly:

- The guard judges only the command text it sees. Inside an allowed tool, such as `node script.js`,
  `make` or a package script, the code runs with the account's rights and can read, write or run
  anything the account can, the guard's own files included.
- A package script, or any allowed program, can therefore defeat the guard on purpose. A script can
  drive `sync --interactive` through a pseudo-terminal, which makes sync's refusal of a terminal
  confirmation inside an agent session advisory. The guard prevents mistakes; it does not stop a
  determined circumvention.
- The boundaries that hold against that are the agent tool's own permissions and sandbox, which
  `sync` points at the files the guard depends on ([Guard files and the agent tool](#guard-files-and-the-agent-tool)),
  and server-side branch protection, such as a GitHub ruleset on the default branch. The guard is not
  a sandbox. `gh pr merge` asks because merging is a person's or CI's decision; the ruleset is what
  enforces it.
- `git pull --ff-only` is judged against the remote-tracking ref as last fetched. The pull fetches
  first, so what it merges can be newer than what the guard checked.
- A Git command that needs repository facts, such as a push or a merge, asks when it runs after
  `session --` or `exec --`, because the guard gathers those facts only for the outer command.
- Sync binds the guard to the cockpit that runs it, which is why it refuses to run from a copy
  ([Cockpit commands an agent can run](#cockpit-commands-an-agent-can-run)).
- Codex skips a `hooks.json` it no longer trusts. A script that rewrites `.codex/hooks.json` makes the
  hook untrusted, and the guard stops running until a person trusts the hooks again. Codex's
  `workspace-write` sandbox, which cockpit selects once a sibling is granted to Codex, keeps `.codex`
  read-only to a Codex agent; an agent in another tool can still rewrite it where that tool's
  protection does not cover the shell.
- What a harness does when its hook timeout fires is not measured. The guard keeps its own 25-second
  deadline and refuses at it ([Native adapter behavior](#native-adapter-behavior)).

`[[guards.deny]]` adds commands to the blocked list. `[[guards.allow]]` is the exception mechanism: it
admits a command the guard would otherwise ask about, such as an unknown program or inline code, and
never overrides a hard denial, nor these asks: a push whose destination Git cannot resolve, a push or
rewrite after a command that may move the branch, a staging walk past its bound, a steering
assignment, a cockpit command its table does not admit, an unproven cockpit launcher, Git run with
`--git-dir` or `--work-tree`, a push option the guard does not know, a Git verb that would write guard
files or that rests on a patch whose targets it cannot read, a `gh` merge or repository edit, a
tool-configuration write to the project's `.npmrc`, and an install from a URL or Git source.

`[guards] default = "ask"` is the strict mode: the guard admits only the read-only commands it
classifies, declared build and test commands, cockpit's own agent commands and `[[guards.allow]]`
rules, each one exact command, and asks for everything else, which is every command it cannot prove
safe. The rest of this page describes the blocked list and the strict mode's prompts; where a rule
applies only in one mode, it says so. Changing `ask` to `allow` widens what agents may do, so it
waits for a person's sync.

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

A cockpit command is allowed only when it matches an exact available public command profile:
executable, working root, bounded complete argument vector, resolved configuration path, declared
services, permitted option roles and inspected paths. Internal guard transport and public commands
marked unavailable are excluded. Declared project build and test commands are allowed only as their
exact argument vectors in their own checkout. A wildcard over a command family never grants
permission.

The command after `session --` or `exec --` is judged as one more invocation, so neither admits what
the guard would refuse on its own. `exec` runs it in a product container whose files the guard
cannot see, so a read-only proof about host paths does not carry over: the name-based denials
(`.env*` and the rest) still apply, as in `exec --service web -- cat .env`, and it is admitted only
by a `[guards] allow` rule or as a declared build or test command; otherwise it asks, which Codex
and OpenCode turn into a denial.

## Hard controls and prompts

Evaluation runs in this order: built-in hard denials, declared denials, checks cockpit could not
complete, declared allows, the built-in read-only profile, then `ask`. A declared allow therefore
cannot bypass any boundary below.

### Instances, secrets and hosted endpoints

The guard denies mutation or staging of a declared environment instance, and mutation below a
secrets directory. That covers command and patch removals as well as writes, removing a directory
that contains either, and staging a containing directory that could include either.

Every `.env` and `.env.*` file at any depth is treated as holding secrets, declared or not: a guarded
tool call that names one to read, write, remove, stage or link it is a hard denial. The guard judges
the names it can see; a program that opens the file itself is not seen. The
documentation names `.env.example`, `.env.sample`, `.env.template` and `.env.schema` are exempt from
the guard, and so is every declared environment `template`; native permissions may still refuse them
([Reading secrets and instances](#reading-secrets-and-instances)), and `cockpit env keys` and
`cockpit env schema` are the supported route to them. Another name that starts with `.env`, such as
`.envrc`, is not denied, but reading it prompts.

Run a trusted process instead of reading values: an agent uses a declared project command or script
that wraps Varlock, because the guard asks about a bare `varlock run` and Codex and OpenCode refuse
what it asks about. A person in a terminal runs that same command, or
`VARLOCK_TELEMETRY_DISABLED=true varlock run -- <cmd>`, without `--redact-stdout`. Redaction is an
output safeguard, not confinement of the child process.

A schema's exemption has a limit: it is documentation to the guard and code to Varlock, as
[A schema runs only once committed](environment.md#a-schema-runs-only-once-committed) explains.

Executable use of a declared hosted database or vendor host is denied at hostname boundaries.
Matching examines executable, argument and environment-assignment-value roles; redirects, heredocs,
comments and definitions do not count. Host names are compared after Unicode compatibility
normalization, so fullwidth letters and ideographic full stops, which resolvers fold to ASCII, do
not hide a declared host.

### Configuration, Git and guard controls

**The configuration and ownership manifest.** Every guarded call reads the configuration file and
`.cockpit/generated-environment-ownership.json`, so losing either holds the agent until a human
restores it. Deleting, renaming, truncating, relinking or making either unreadable is a hard denial,
and so is removing a directory that contains either. The guard recognises this through `rm`,
`unlink`, `mv`, `git rm`, `git mv`, `find -delete`, `truncate`, `git archive` output, truncating
`dd` or `tee` writes, `ln` onto either file, a `chmod` mode that drops the owner's read permission
or is copied with `--reference`, a patch delete or move, a Write tool call with empty content, and a
`>` redirect. Editing the configuration in place stays permitted, including bounded
`dd conv=notrunc` and `tee` append forms under the normal write checks; the edit takes effect only
after `sync`, and only a person's sync applies an edit that
[widens what agents may do](#edits-the-guard-has-not-applied).

**Git.** Writing anywhere under a `.git` directory is a hard denial, because Git configuration
chooses programs that read-only Git commands run. So is every `git config` form other than a proven
read (`--get`, `--get-all`, `--get-regexp`, `--list`, `get`, `list`, or a lone `section.key`),
whatever its scope: a global `core.pager` or `core.hooksPath` reaches every repository. The one
exception is the allow default, which admits writing a single plain key to the repository's own
configuration, such as `user.name`, `user.email`, `pull.rebase`, `merge.ff` or `fetch.prune`, with
`--local` or no scope option.

**Guard controls.** Removing, renaming or directly overwriting a guard control is a hard denial, as
is removing a directory that contains one or an executable control below a protected plugin
directory. Otherwise an exact command allow could disable a hook before the next guarded call. The
protected files include every harness's native MCP and permission outputs derived from the shipped
harness registry, the MCP wrapper scripts under `.cockpit/mcp/`, the work-order records under
`.cockpit/work-orders/`, which carry no key, so one an agent wrote would read as a person's, and
`.cockpit/policy.json`, the [autonomy policy](#who-decides) the last sync accepted. This boundary
follows folded path spellings and verified filesystem identities, so alternate case and aliases do
not bypass it.

**Installed code.** The guard checks its entry point's digest, but an edited module it loads could
turn every hard denial into an allow. So these are hard denials:

- writing, linking, changing the mode of, or removing anything inside the running cockpit package or
  any package it loads, under both its installed path and its real path, or removing a directory
  that contains one;
- writing into any `node_modules/.bin` directory of a configured root;
- creating, replacing or linking a file directly inside a `PATH` directory that lies within a
  configured root, where a planted `ls`, `git` or `rg` would run in place of a permitted read-only
  command.

**Relative `PATH` entries.** Only absolute search path entries can be protected: a relative entry
such as `.`, `./node_modules/.bin` or an empty one names whatever directory a command runs in, so a
file the agent wrote could run in place of a permitted command, or as the interpreter
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs` starts through `#!/usr/bin/env node`. While the harness's `PATH` holds
one, no command is allowed without a prompt, and the reason names the entry. Keep relative entries
off the `PATH` an agent harness starts with. `doctor` reports one in the `PATH` it runs with as
`GUARD_SEARCH_PATH_RELATIVE`; that describes the CLI process, not a running harness's environment,
so check the shell or launcher that starts the harness before changing its configuration. A wrapper
that injects a relative bin directory produces the warning for the command it starts; the pnpm
release tested put an absolute directory first under `pnpm exec` and gave no warning, so do not read
it as coming from pnpm.

For their own Git and Docker observations, `doctor`, `preflight`, `check`, `docs check`, and `sync`
for checkout identity and native-hook revision, use only the absolute directories already on `PATH`,
in order, so changing into a sibling cannot select a different tool. `up` and the other commands
that start or change a stack keep their strict search and refuse, stating the reason. A noncanonical
absolute entry, such as `/usr/bin/../bin`, still refuses the observation, and with it `sync` and
`check` wherever they have Git to ask or Compose to read; put the tool in a canonical absolute
directory. Git simply missing from `PATH` does not refuse a cockpit with no runtime
([Environment modes](environment.md#environment-modes)). This does not change the environment used
to start sessions, discover evaluators or check MCP commands, the guard's approval rules,
publication authorization or the native hook's execution environment. A completed observation does
not establish that a harness runs its generated hooks or that an integration works.

**Other.** The Claude Code registration includes `NotebookEdit`, so notebook cell changes get the
same protected-path checks. For a configuration in a repository subdirectory, these controls belong
to that directory. Start Codex there: its generated hook resolves the guard from the canonical
session directory, not from an enclosing Git repository.

### Guard files and the agent tool

The guard judges command text, so a program it does not understand, such as an inline script, can
still rewrite the files it depends on. `sync` therefore also writes each agent tool's own write
denials for them: every guard control above (the guard script, `.cockpit/local`, `.cockpit/policy.json`,
the ownership manifest, every hook registration, plugin and native MCP or permission file, the MCP
wrappers, the work-order records and the adopted copies), the root secrets directory, and the Git
state in the cockpit and every sibling that chooses programs Git runs outside any agent tool: the
hooks and configuration in `.git`, every `config.worktree` below it, and each submodule's hooks and
configuration under `.git/modules`. `cockpit.toml` is not one of them: agents edit it, and the guard judges
whether an edit [widens what agents may do](#edits-the-guard-has-not-applied). These denials apply
to the agent tool only; `sync` and `upgrade` run by a person in a terminal rewrite the files as
before. They are narrower than the guard's own rule, which refuses any write below a `.git` directory.
What each tool enforced is dated in the [capability matrix](capability-matrix.md):

| Tool | What `sync` writes | Edit and write tools | Shell |
| --- | --- | --- | --- |
| Claude Code | `Edit(...)` deny rules in `.claude/settings.json` | refused | a redirect or `cp` into a denied path is refused; any other program writes unless Claude Code's sandbox is on |
| Codex | nothing more: the sandbox settings it writes have no read-only path | inside its `workspace-write` sandbox, `.codex` and every `.git` directory refused; `.cockpit` written | the same |
| OpenCode | `edit` deny patterns in `opencode.jsonc` | refused | written: OpenCode has no sandbox, and its `bash` permission matches command text as the guard does |

**Claude Code's sandbox** closes the shell gap: with `sandbox.enabled` and
`allowUnsandboxedCommands: false`, Claude Code adds the `Edit(...)` denials to the sandbox's own
write denials, and a program run from the shell was refused each protected write. cockpit does not
turn the sandbox on, because it changes every shell command the agent runs, with limits of its own
that Claude Code documents, and cockpit commands an agent runs that write these files, such as `sync`
and the `work` commands, fail inside it. So does a Git command that writes `.git/config`, such as
`git config` or a push that sets an upstream. Commits, branch switches, fetches and `git worktree add`
kept working in the cockpit, its linked worktrees, siblings and their submodules. A team that wants
the sandbox adds the `sandbox` key to its [adopted settings](getting-started.md#adopt-existing-agent-settings), which cockpit keeps beside its
own, and runs those commands from a terminal:

```json
{ "sandbox": { "enabled": true, "allowUnsandboxedCommands": false } }
```

**Git state left unprotected.** The files that tell Git where a repository lives are a linked
worktree's or a submodule checkout's `.git` file, and the `gitdir` and `commondir` files in
`.git/worktrees/<name>`. Rewriting one points Git at a directory whose configuration chooses the
programs Git runs. Only OpenCode's denial covers them, since it binds only its edit tool. Claude Code's
cannot: its sandbox turns a denial into a filesystem write denial, and a rule naming `.git` made every
Git write fail, while one naming `gitdir`, `commondir` or a worktree's `.git` file made `git worktree add` fail. Claude
Code asks before its edit tools touch them, and its sandbox leaves them writable to the shell. Codex's
sandbox refuses the `gitdir` and `commondir` files with the rest of `.git`, but leaves a linked
worktree's and a submodule's `.git` file writable. Two more gaps were measured:

- With Claude Code's sandbox on, a shell command could rename a sibling's whole `.git` directory, edit
  its hooks and configuration, and rename it back. The sandbox refused the same rename in the cockpit
  root.
- OpenCode matches its patterns case-sensitively. On a case-insensitive volume, the macOS default, its
  edit tool wrote a denied path spelled `.COCKPIT` or `.GIT`. The guard folds case and judges the same
  edit when the plugin loads; that run had no plugin, so this is not measured.

**Codex.** The `workspace-write` sandbox, which the generated `.codex/config.toml` selects once a
sibling is granted to Codex, keeps `.codex` and `.git` read-only in the cockpit and every granted
sibling, so a Codex agent cannot rewrite its hook registration or a Git hook, but it can rewrite the
guard script and the rest of `.cockpit`. Without a grant, Codex runs in whichever sandbox the person
configured. A Codex permission profile can name read-only
paths, but cockpit has not yet shown a Codex session loading one from the project file, so it writes
none.

### Destinations, sources and links

The evaluator resolves visible destinations for bounded `cp`, `install`, `mv`, `ln`, `git mv`,
`git archive`, `tee`, `dd`, `touch`, `truncate` and `chmod` forms, and bounded `tar` extraction
forms. Git paths use the directory selected by `git -C`. Extraction without an explicit destination
writes to the working directory. Visible source files for bounded `cp`, `install`, `dd` and `tar`
forms get the same protected read check as read-only commands.

A hard or symbolic `ln` whose target is, contains or lies inside a secrets directory, a declared
instance, a guard control or the installed cockpit is a hard denial. A symbolic link's target is
checked from both the working directory and the link's own directory.

These are `unavailable`: every unsupported `tar` or `ln` mode or option, and a command whose visible
operand names a control, a protected plugin subtree or a directory containing either and that the
guard cannot classify. These checks run before declared allows. They do not inspect archive member
paths or the bodies of approved scripts, and classifying an extraction directory does not prove an
archive cannot traverse outside it. An exact command rule permits that command; it is not a
filesystem sandbox. To restore or replace generated controls, stop the guarded session and have a
human run `cockpit sync --config cockpit.toml` in a terminal.

### Protected branches and prompts

Pushes to declared protected branches are hard denials, including explicit protected destinations
and `git push --all` or `git push --mirror`, and so are force pushes and remote branch deletion of
any branch. A push with no refspec goes where the repository's `@{push}` points, and `HEAD` or `@`
names the current branch; the guard asks Git for both. A destination Git cannot resolve, and
ambiguous source-only revisions, symbolic aliases and wildcards, ask and name the spelling that
works, `git push origin <branch>:<branch>`. No grant overrides either boundary.

In the strict mode these produce `ask`: unresolved Git execution context, destructive Git reset or clean forms, staging
by explicit path (a person approves or runs it), staging without explicit paths, wrapped or
environment-modifying commands, unmatched invocation profiles, and any removal without a grant. An
explicit removal outside configured roots stays at `ask` even when a declared allow matches, because
cockpit cannot verify its target.

`git add -A`, `git add .` or a directory operand covering a secrets directory at any depth or an
environment instance is a hard denial: stage the changed files by name. The guard walks the operand
to find nested secrets directories; a tree past the walk's bound stays at `ask`, and a walk that
fails is `unavailable`. Unsupported staging options or unproven pathspec grammar produce
`unavailable`.

In the strict mode, any other refused command gets an `ask` that names the command and gives three
ways forward: a person approves it, a person runs it in a terminal, or a person admits it under
`[guards] allow`; for tests it points to `cockpit test-run`. Under the allow default these commands
run, except a program the guard does not know or inline interpreter code, a reading command such as
`cat`, `rg` or `grep` whose shape the read-only profile could not prove reads no secret, Git that
prints committed content outside the profile, and a cockpit command its own table does not admit.

### Git updates to guard files

A repository's work tree can hold guard controls, the secrets root or a declared instance, and some
Git verbs write another revision's files into the work tree. A commit made in a second worktree and
merged back replaces a tracked guard with every step allowed, so the guard asks Git, before the
command runs, which of those paths the revision would change. The verbs are `merge`, `checkout` and
`switch` to a revision (not a pathspec form, and not a branch created from `HEAD`), `reset --hard`,
`--merge` and `--keep`, `cherry-pick`, `revert`, `rebase`, `stash pop`, `apply` and `push`, and
`pull --ff-only`. A verb that would change such a path is refused. Two outcomes are asks:

- The revision does not resolve, or Git does not answer.
- The content arrives only as the command runs: a plain `git pull`, `git pull --rebase` or a pull
  that names another source, in a work tree that holds guard controls. Fetch first, then run
  `git merge --ff-only <remote>/<branch>`. An earlier command in the same call that can change the
  revision asks too.

`pull --ff-only` is judged against the remote-tracking ref as last fetched, not against what a later
fetch brings. `git checkout-index -a` and `git read-tree -u` ask, because they write every indexed
file. `git am` and `git apply` read a patch file's headers to find the paths it writes: a patch that
names a guard control is refused, and one whose targets the guard cannot read asks, as with an
encoded mail body (base64 or quoted-printable), quoted or unparsed headers, or no diff at all. So do
a patch from standard input and `-p`, `--directory` or `--unsafe-paths`.

### Declared rules

Declared rules refine the final prompt boundary: under the allow default an allow rule matters only
for what would still ask. Each vector starts with the executable.
`[[guards.deny]]` matches a command-vector prefix or a contiguous sequence and may name a safe fix.
`[[guards.allow]]` matches a prefix, optionally only at one checkout-relative working directory. An
allow cannot bypass a hosted endpoint, protected branch, secret path, malformed capture or
unavailable filesystem evidence. In the strict mode wrapped and environment-modifying invocations
are never allowed by a declared rule, because wrappers can change which program runs; the one
exception is the program a package launcher runs, which a rule or declared command for the launcher
spelling admits, as `pnpm exec vitest run` is admitted by a rule for it. A rule that admits an interpreter,
such as `["node"]`, `["python3"]` or `["perl"]`, admits whatever code it is given, inline or in a
file, and the guard cannot see what that code writes, guard controls included; without such a rule
inline code asks under the allow default, and every interpreter run asks in the strict mode.

Malformed or oversized input, incomplete policy, escaped or symlinked path evidence, inspection
failure and exceeded limits produce `unavailable`. The
[invocation parser](../packages/cockpit/src/guards/invocation-parser.ts) captures bounded input
once; the evaluator accepts only input that parser produced.

### Read-only commands

A built-in read-only profile lets agents inspect the checkout without a prompt, which matters most
on Codex and OpenCode, where a prompt becomes a denial. It covers exact argument shapes of `ls`,
`pwd`, `cat`, `head`, `tail`, `wc`, `shasum`, `rg`, `grep`, `fd`, `find`, `jq`, `echo`, `printf`, `sed`,
`git status`, `git diff`, `git log`, `git show`, `git grep`, `git blame`, `git rev-parse`, `git branch` listing flags,
`git worktree list`, `git ls-files`, `git cat-file`, `git merge-base`, `git remote`, `git config --get`,
and the cockpit commands [below](#cockpit-commands-an-agent-can-run). The
[read-only profile](../packages/cockpit/src/guards/read-only.ts) lists each permitted option.

- Any other option falls back to the ordinary rules, including options that run programs or write
  files: `rg --pre`, `find -exec`, `find -delete`, `fd --exec`, `git -c`, `git --output`,
  `git --ext-diff` and `git diff --no-index`.
- Options whose value is optional, such as `grep --context` on macOS, are accepted only as
  `--option=value`.
- `printf` is read-only only without options. `sed` only prints: `sed -n '5p'` or `sed -n '1,$p'`
  with numeric or `$` addresses. `git rev-parse` is read-only except `--git-path`,
  `--resolve-git-dir`, `--parseopt` and `--sq-quote`. `git branch` is read-only with no argument or
  with `--list`, `-a`, `-r`, `-v`, `-vv` or `--show-current` (and their long forms), never with a
  branch name. `git worktree list` accepts its porcelain, NUL and verbose listing flags;
  worktree creation, removal and pruning remain outside the read-only profile. `git ls-files` lists
  names, modes and object names, never with `--eol`. `git cat-file` takes one of `-t`, `-s`, `-e` or
  `-p` and one object, never a `rev:path` blob name; `-p` prints content, so it is judged as
  `git show` is. `git remote` lists names only: `-v`, `show` and `get-url` print URLs, which can
  carry a credential. `git config --get <key>`, `--get-all` and `git config get` read one key from
  the `user`, `core`, `init`, `pull`, `push`, `merge`, `rebase`, `commit`, `tag`, `fetch`, `status`,
  `log`, `diff`, `color`, `advice`, `safe` or `gpg` section, with scope and display flags; a listing,
  a pattern, `--file` or a key in another section, such as `remote.origin.url`, `http.extraHeader`
  or `credential.helper`, can print a credential, so it asks. Every configuration write is refused.
  In the strict mode `git fetch` writes objects and refs under `.git`, which agents do not write, so it asks: read the
  other repository in place with `git -C <repository> log`, or a person runs the fetch. `shasum` hashes
  named files, including guard controls, with algorithm and text/binary options. Check mode is
  excluded because a checksum manifest names additional files. Output redirects remain writes.
- `$?` is allowed as an argument only to a read-only command, and never as the directory of
  `env -C`.
- A command may follow `cd ./dir`, `cd ../dir` or `cd /abs/dir` joined by `&&` or `;`, with the
  directory judged as its working directory. A bare `cd name` is refused, because `CDPATH` can send
  it elsewhere: write `cd ./name`, or `git -C name`. A `..` after a directory name, as in
  `cd ./a/../b` or `env -C a/..`, is refused too, as are `pushd`, `popd` and zsh's `chdir`. A `cd`
  may fail, and one after `||` may not run, so each later command is judged from every directory it
  may run in: in `pwd || cd ./dir && cat x` the `cat` is judged from both. A newline after `&&`,
  `||` or `|` continues the list. A `cd` in a pipeline is refused, and a list ending in `&` runs in
  a subshell, so its `cd` moves no later command.
- Git runs read-only only in a directory with its own `.git`, because Git otherwise treats a
  directory holding `HEAD`, `objects` and `refs` as a repository and honours its configuration. Git
  operands are inspected as files whose content may be printed.
- `rg` is read-only only when `RIPGREP_CONFIG_PATH` is absent. Its `-g`, `--glob` and `--iglob` are
  read-only only as `!` exclusions: any other glob overrides the hidden and ignore filters, so
  `rg -g '.env*'` would print a hidden environment file. Under the allow default `rg` also takes
  positive globs, `--hidden`, `--no-ignore` and `-u`; the guard then walks the whole tree it reads,
  hidden and ignored files included, and refuses the search if it finds an environment file or
  secrets directory there.
- Under the allow default a word whose value the guard cannot see, such as `$TARGET`, a glob or a
  command substitution, is allowed in an argument the program decides about, as in
  `node build.js "$TARGET"`. It is refused where the guard decides what is read, written, removed or
  pushed (`cat "$FILE"`, `rm "$DIR"`, `git push origin "$BRANCH"`) and as the program name, and it
  asks when it is an unexpanded glob that can match a secret or credential name (`nl .en?`). An
  assignment value or loop item that names one asks too, since the word that uses it is not visible
  (`f=.env; nl "$f"`). `~` and `$HOME` are expanded unless the call changes HOME.
  `git commit -m "$(cat <<'EOF' … EOF)"` is read as the literal message it is. Printing the
  environment or a variable named as a secret (`echo "$API_TOKEN"`) is refused. In the strict mode
  every such word is refused.
- A push or history rewrite that rests on the current branch asks when an earlier command in the
  same call is not read-only, since it could move the branch.
- A pipeline or chain is permitted only when every segment is. Redirecting output to `/dev/null`,
  `/dev/stdout` or `/dev/stderr`, or input from `/dev/null`, does not change the decision.

### External inputs and native permissions

Each agent tool already has its own permissions for files outside the project: Claude Code's
permission rules and additional directories, Codex's sandbox and approval policy, OpenCode's
`external_directory`. Cockpit never overrides them: its successful hook response is neutral, so a
native denial still wins. What cockpit adds is its own guard on shell commands, and a person picks
how that guard treats a named file outside the managed roots:

| Setting | A named read outside the roots | Use it when |
| --- | --- | --- |
| default | asks, unless a `[guards] allow` rule names the complete command | external reads are rare and each is reviewed |
| `read_paths` | allowed below each listed file or directory | a few known folders, such as `~/Downloads` or a memory directory, held by cockpit itself |
| `external_reads = "native"` | left to the agent tool's own permission, as is a read-only Git command run alone in another repository | the person already manages outside access in each tool's settings |

```toml
[guards]
read_paths = [{ path = "~/Downloads", reason = "Inputs the person drops in." }]
# or hand every named external read to the tools' own permissions:
# external_reads = "native"
```

`~/` means the home directory of whoever runs the agent. A listed path that does not exist grants
nothing, and `/` or the home directory itself is never granted. In every mode the guard still
refuses `.env*` and `.secrets` names and declared instances, writes outside the roots, an external
working directory (except, with native external reads, a read-only Git command's `-C` directory, below), and a recursive search or comparison of an external directory: outside the
roots it recognises only those names, not other credential files, so a read or search must name a
regular file, and only a listing, which reports names, may name a directory. A link outside the roots stays refused. Copying an input in, as
`cp ~/Downloads/photo.jpg assets/`, is a write and is admitted as any write is, for example by a
`[guards] allow` rule for `cp`.

Choosing native external reads hands named reads to each tool's own boundary. That boundary
differs: Codex's sandbox reads most of the disk unless its own permissions narrow it, while Claude
Code asks for an unapproved shell command and OpenCode applies `external_directory`. Adding a read
path or switching to `native` widens what agents may read, so it waits for a person's sync;
removing one takes effect at the next sync.

For a single command, a person reviews the **complete** argv and an explicit managed `cwd` instead:

```toml
[[guards.allow]]
argv = ["rg", "-n", "decision", "/workspace/selected/notes.md"]
cwd = "."
reason = "Read the selected design notes."
```

For that exact grant the entire argv must match, options included; the usual prefix matching is
insufficient. Each argv word is at most 128 characters. OpenCode's own read tool reaches the guard
as `cat -- <path>`, and its refusal names that form, so a grant for OpenCode reads spells it that
way. A file-read approval grants no external writes, execution roots or shell working directory,
and redirection to another file is never covered.

A reviewed `git -C /workspace/related status --short` or `git -C /workspace/related log` can inspect
a related checkout from the managed cwd; changing its branch remains a separate operation, and
commands that print file content there, such as `diff` or `show`, stay refused. **External Git
approval is command execution consent**, including that repository's configured helpers: status can
run fsmonitor and clean filters. Review that configuration before approving the command; the
approval is bound to the argv, so a later change to those helpers is not detected and needs another
review. It runs only as the whole call, never as part of a pipeline or chain whose file evidence a
helper could invalidate.

With `external_reads = "native"`, a read-only Git command in a repository outside the roots, such as
`git -C /workspace/related worktree list --porcelain`, is left to the agent tool's own permission
without a grant, as a named file read is. The guard still requires the read-only profile's exact
form, so no `-c`, alias, external diff, pager option, write or network access passes; the whole call,
never a pipeline or chain; a `-C` directory holding its own `.git`, reached without a link; and
operands that name regular files or revisions. A command that prints file content there, such as
`diff`, `show`, `log -p` or `cat-file -p`, is admitted only when that repository's index tracks no
`.env*` or `.secrets` file, as inside the cockpit. Running it runs that repository's configured
helpers, such as fsmonitor, clean filters, textconv, signature verification and the pager, as
running it yourself would. Agents cannot write outside the roots, so those helpers are what a person
or their tools configured there, and choosing native external reads hands consent for that command
to the agent tool, which asks or sandboxes it by its own rules.

A named file, or a search or listing, under a managed root may follow a package-manager link to a
target inside a managed root: a named read only to a regular file, a search also to a directory,
which is then walked for secrets as any search is. Both spellings and the target's identity are
checked, and the link is revalidated before the decision is returned.

A `[guards] allow` rule admits a command the read-only profile cannot classify, but never past the
secret names: each argument is checked whole, after `=`, after `:` and after an attached short
option, so `cat README.md .env -x` (`cat` prints `.env` before it rejects `-x`) and
`git show HEAD:.env` are denied under any rule. Another command that names one, such as
`docker compose --env-file .env up`, may only pass the name on, so it asks instead. A rule for a
reading command such as `cat`, `head` or `rg` asks for an argument outside the roots that no read
path or native external reads covers, and no rule admits a search the guard found would read an
environment file.

Review memory directories or selected files narrowly. Configuration and logs can contain secrets:
list a named safe file or a redacted copy rather than a whole agent configuration directory. The
existing secret, hosted-endpoint, protected-branch and control-write denials take precedence. A
path approval cannot override them.

Adding or widening a rule is held until person-owned sync activates it. Removing a rule or changing
its scope invalidates the old permission on the next call, before another sync. Re-trusting hooks
does not repair missing location authority or unsupported command arguments.

A Node test verifier remains executable code, not a read-only inspection command. Keep its
`node --test --test-concurrency=1 <verifier>` argv: a person admits that argv under `[guards] allow`,
or declares it as a `[[testing.stages]]` command in a gate that agents run with `cockpit test-run`.
Do not substitute a gate whose stages use another runner, or grant the whole `node` interpreter.

Measured on 2026-11-07 with Claude Code 2.1.319, Codex CLI 0.167.0 and OpenCode 1.19.5, each driven
by a loopback synthetic model against an installed cockpit. Codex ran with hook trust forced for the
run (`--dangerously-bypass-hook-trust`), as a person's trust would give it. In all three:

- with exact grants, the granted file read and the granted related-checkout status ran, while an
  ungranted external read, a redirect into the external directory and an external `.env` read were
  refused by the guard;
- with a read path, a file in it was read and the directory listed, while a file in an unlisted
  directory and the read path's `.env` were refused;
- with `external_reads = "native"`, files in both directories were read, while `.env` and a
  recursive search of the external directory were refused;
- with a native rule refusing `cat` (Claude Code `--disallowedTools`, a Codex execpolicy `forbidden`
  prefix rule, an OpenCode bash `deny` pattern), each tool refused a read the guard allowed.

Without its own `external_directory` grant, OpenCode rejected an external read before the guard
ran. These runs establish behaviour for these versions only; cockpit imports no tool's settings.

### Cockpit commands an agent can run

| Command | Decision | Why |
| --- | --- | --- |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs check --config cockpit.toml`, and likewise `doctor`, `preflight`, `ps`, `logs --service <service>`, `stacks`, `stacks prune`, `docs check`, `env keys`, `env schema --path <schema reference>` and `sync --dry-run` | allowed | They read and report; nothing they do changes a file the guard relies on. A `--path` that names anything but `.env.schema`, or that climbs, is a prompt. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs --help`, `./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --help`, and the version | allowed | They print and exit before any command runs. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs up --config cockpit.toml`, and likewise `sleep`, `down`, `restart --service <service>` and `rebuild --service <service>` | allowed | They act only on the stack cockpit declared and owns; `down` keeps data volumes, and deletes only from the local Docker daemon it fixes at the start of the run. |
| `up --profile <profile>` | allowed for a profile in `environment.profiles` that mounts no sibling with `gate = "operator"`, otherwise a prompt | Another profile starts services no person declared for agents, and an operator-gated sibling touches live data or local hardware. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs env schema --config cockpit.toml --path <schema reference> --replace-from <draft>` | allowed only as the whole command, for a draft the guard can prove safe to read; otherwise a prompt | A schema that is not committed is never run, and a draft that could hold a secret is refused, so a replacement cannot launder one back out through `env schema`. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs exec --config cockpit.toml --service <service> -- <command>` | allowed when a `[guards] allow` rule or a declared build or test command admits `<command>`, otherwise a prompt | The command runs in a container whose files the guard cannot see, so it is never proven read-only, and the name-based denials still apply to it. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs pull --config cockpit.toml` | allowed | It only fetches and fast-forwards, and leaves a modified or diverged checkout as it was. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs use <slug> <checkout> --config cockpit.toml`, and `use <slug> --clear` | allowed for a checkout inside a directory the agent may already write, otherwise a prompt | The choice is recorded for this checkout of the cockpit only, so it never widens what the agent can reach. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs runtime measure --config cockpit.toml --image <local-image>` | allowed | The probe runs a disposable stack under its own project, removes it, and records the result only in this machine's git-ignored state; `cockpit.toml` never changes. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs session --config cockpit.toml -- <command>`, with a `--profile` that `up` admits | the decision for `<command>` | A session runs its command as the agent could run it directly, so it never admits more. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs test-run --config cockpit.toml --gate <gate>`, with an optional `--mode` and a `--select <kind>:<value>` whose value does not start with `-` | allowed for a gate `cockpit.toml` declares | The gate runs only the stages a person declared in the reviewed configuration, the trust `up` already has. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs work status --config cockpit.toml`, `work accept`, `work check`, `work note`, `work decide`, `work answer`, `work acknowledge`, `work grade`, `work signoff`, `work recover` (with or without `--apply`), `work verify` and `cockpit grade --criteria <file>`, each with its own options | allowed | They report, or take a step [`[work.gates]`](#who-decides) gives the agent; a step it gives a person waits for the digest typed after `--interactive`, which no agent invocation carries. Grading runs in a separate evaluator. `work recover --apply` removes a lock only once it has shown the holder gone on the lock's own host and among the containers cockpit labels. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs sync --config cockpit.toml`, and `upgrade`, whose sync child writes | allowed where `[autonomy] sync = "agent"`, otherwise a prompt | It regenerates the files the configuration declares; after `cockpit.toml` changes, the guard admits it only when the edit [does not widen](#edits-the-guard-has-not-applied) what agents may do, so an agent's sync never publishes a widening of its own. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs tool add <tool> --config cockpit.toml`, with an optional `--dry-run` | allowed | It edits only `[surfaces] tools`, and an added tool [does not widen](#edits-the-guard-has-not-applied) what agents may do, so the agent's sync applies it. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs reset --config cockpit.toml --apply` | allowed where `[autonomy] reset = "agent"`, otherwise a prompt | It deletes stack data. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs stacks prune --config cockpit.toml --apply` | allowed; the command itself refuses a prune that deletes volumes unless `[autonomy] reset = "agent"` | It removes only stacks whose checkout is gone, which bringing the stack up again recreates, and their data only where a reset could delete it. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs browser drive --config cockpit.toml`, and likewise `screenshot`, with an optional `--role` | allowed where `browser.request_preapproval` is on, otherwise a prompt | They sign in and capture the declared application, so they run unprompted only on the isolated, non-production data the configuration declares. Preapproval is on by default exactly when `browser.data` is isolated, not restored and not reaching production, and off otherwise; an explicit `request_preapproval` wins, and `true` on a posture that does not qualify is refused. `drive` also accepts `--fail-on-findings`. |
| `work accept`, `work answer`, `work acknowledge` and `work signoff` with `--interactive` | a prompt, which Codex and OpenCode turn into a denial | `--interactive` asks for a person at a terminal to type the digest of what it shows. |
| `./node_modules/@b00dea/cockpit/bin/cockpit.mjs setup --config cockpit.toml --write-instruction-files`, and likewise `--write-instruction-pointers` | allowed where `[autonomy] instruction_files = "agent"`, otherwise a prompt | They write the sibling `AGENTS.md`, `CLAUDE.md` and guide links `setup` proposes, which the agent could write with its own tools. |
| `sync --adopt`, `sync --interactive`, `reset --interactive`, `stacks prune --interactive`, `sibling add`, `sibling remove`, `tool remove` and every other command | a prompt, which Codex and OpenCode turn into a denial | They widen what agents may do through `cockpit.toml`, rewrite a team's own settings, ask for a person, or delete data. |

`sync` and `upgrade` bind the guard to the cockpit module that runs them, and an agent can edit a copy
of cockpit. So sync refuses unless the running module is the installed
`<root>/node_modules/@b00dea/cockpit/dist/cli.js`, compared by real path. In a root with no installed
package, such as cockpit's own development checkout, it refuses only when it would rebind the guard
from a different module than the one already bound. The guard refuses `node <copy>/dist/cli.js sync`
and `upgrade` from a copy of cockpit inside the roots, and asks for any other run of such a copy.

A file such a command names, like `--criteria`, is checked as a read: a declared instance, a file
below `.secrets` or a `.env` or `.env.*` file that is not documentation is denied, and a symlink or
a path outside the configured roots prompts.

"Allowed" means the guard does not object. Claude Code also needs its own allow rule, which the
generated settings carry for the commands the shipped skills use
([Claude Code command rules](harness-surfaces.md#claude-code-command-rules)); in Codex's sandbox
most of these commands must run outside it
([Run cockpit outside the Codex sandbox](harness-surfaces.md#run-cockpit-outside-the-codex-sandbox)).

Run these exactly as shown. A prefix such as `env -u NAME` or `nohup` makes any of them a wrapped
invocation, which prompts, and none needs one. They count from the cockpit root with `--config`
naming the configured `cockpit.toml`; `check`, `doctor` and help also count from any directory. Each
spelling counts only where the guard proves it starts its own installed package:

- the installed entrypoint `./node_modules/@b00dea/cockpit/bin/cockpit.mjs`, a `.bin` symlink, or a
  path given to `node` must resolve to it. `node` is bare, or the absolute path of the `node` in a
  directory the agent's command search path names, spelled as that entry spells it, such as
  `/opt/homebrew/bin/node` when `/opt/homebrew/bin` is on its `PATH`;
- bare `cockpit` must be what the command search path finds first;
- the npx spellings must run from the cockpit root with no root `.npmrc` and no `bin` or
  `directories.bin` in the root `package.json`, because npm would otherwise run that program or
  apply that configuration first. Writing an `.npmrc` anywhere inside the configured roots is
  denied. Any other npx option, or npx without `--no` (which may download a package), is not the
  installed cockpit.

Where npx cannot be proven, every npx spelling prompts, and Codex and OpenCode refuse it, while the
path spelling still counts from the cockpit root. pnpm writes `node_modules/.bin/cockpit` as a shell
shim neither can follow, so there the provable spelling is
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs doctor --config cockpit.toml`. Everything cockpit
prints, the `cockpit:*` package scripts included, uses that spelling, so `doctor` reports
`COCKPIT_LAUNCHER_UNPROVEN` only where a person can make npx provable, as by removing a root `.npmrc`,
or where no spelling is provable. Generated skills and the
launcher refusal recommend the direct package entrypoint; replacing it with another executable
still requires approval. The guard does not check which
`npx` the search path finds: it assumes that program behaves as npm's own, as the version-manager
and package-firewall shims that hand over to npm do.

### Reading secrets and instances

Every hard denial still applies first. Reading a declared instance, a `.env` or `.env.*` file that
is not documentation, or anything under a `.secrets` directory is denied under every spelling that
resolves to it, including a case-folded spelling of the checkout, and so is a recursive search
rooted at or below one. Shell reads also compare filesystem identity: a hard link to a declared
instance, or to any file in the cockpit's `env/.secrets` directory, is denied like the file itself.
The guard enumerates that directory on every call, up to 512 entries; above that bound every content
read falls back to a prompt. A hard link to a file in any other `.secrets` directory is recognised
only by its spelling.

These reads fall back to a prompt instead of being allowed:

- a recursive search, whenever a declared instance or an `env/.secrets` file has a second hard link
  anywhere;
- a search whose tree contains an existing instance, a `.secrets` directory at any depth, or a
  `.env*` file that is neither a declared template nor a documentation name. The guard walks each
  searched tree without following links, and a tree too large for its bounded walk is not searched
  either. The reason names the path, so the agent can search a narrower one;
- an `rg` search that would read one. ripgrep skips what Git ignores, so the guard asks Git which
  files the enclosing repository does not ignore, and a gitignored `.env` or `node_modules` does not
  block it. Hidden files count, because a type such as `rg -t sh` reads a `.env`. Where Git's list
  cannot stand for ripgrep's (outside a repository, with an `.ignore` or `.rgignore` file in or
  above the tree, through a nested repository or submodule, below a `.git` or `.jj` entry, when the
  search names an ignored path, when a `.gitignore` holds a line the two glob engines may read
  differently, such as braces, a POSIX class, a backslash escape, trailing whitespace, a `**` that
  is not a whole path component, or non-UTF-8 bytes, or when Git does not answer), the search is
  walked like `grep -r`. Either way the guard sees only what exists before the call runs, so a
  recursive search is allowed only when every other command in the call is read-only too;
- `git diff`, `git show`, and `git log` with patch output, whenever the repository's index holds a
  `.env*` file that is neither a declared template nor a documentation name, a file below a
  `.secrets` directory or a declared instance, unless the command names no revision and is limited
  with `-- <path>` to paths that hold none (`git log` may name revisions, but not `--full-diff`).
  `--check` counts as printing content, and `git log -L<range>:<path>` is not read-only. Only the
  index is asked: a file committed once and since removed from it is still in history, and
  `git log -p` prints it. Run `git rm --cached` and rotate what it held;
- a path that is a symlink or leaves one through `..`, lies outside the configured roots, or has
  another `.env*` name, such as `.envrc`.

The guard hook sees shell commands and edits only. Claude Code's own Read, Grep and Glob tools never
reach it, so `sync` also writes Claude `Read` deny rules into `.claude/settings.json`: one for every
`.env` and `.env.*` file, every `.secrets` directory and every declared instance of every sibling,
mounted or not. A sibling instance's rule is anchored on the path below the sibling's parent, so the
committed file is identical on every clone; it can match more than the instance (any file with the
same sibling-relative suffix), never less. In the probe below, Claude refused a symbolic link whose
target was protected. A hard link under a name outside the rules is not covered; the guard's
identity checks cover shell commands only.

| Native read measurement | Observed result |
| --- | --- |
| Claude Code 2.1.318, macOS, 2026-11-05 | Ordinary Read succeeded; Read through an unmatched-name symlink to a synthetic `.env.private` was refused. Explicit `Bash(cat *)` permission let `cat ordinary.txt` run, while `cat .env.schema` was refused. |

Claude's filesystem-root deny rules cannot exempt the documentation names: native file tools and
recognized shell reads such as `cat` also refuse `.env.example`, `.env.sample`, `.env.schema`,
`.env.template` and declared templates with a `.env.*` name. A guard approval does not override
that. Claude's ordered negation exceptions apply only to relative rules, which would leave sibling
secrets outside the protection
([Claude's permission rules](https://code.claude.com/docs/en/permissions#read-and-edit)). The
denials stay. The supported route is
[`cockpit env keys`](environment.md#read-variable-names-and-schemas) for variable names and
`cockpit env schema` for one schema's text, neither of which resolves anything.

### Editing a schema under Claude Code

| Native edit measurement | Observed result |
| --- | --- |
| Claude Code 2.1.318, generated `Read(//**/.env.*)` denials, no hook, 2026-11-05 | Read, Edit and Write of `.env.schema` were refused as covered by a Read deny rule; `cat` and `sed -i` were refused. `git show HEAD:.env.schema`, `printf ... >> .env.schema`, `cp draft .env.schema` and `mv draft .env.schema` worked. |

An agent reads a schema with `env schema`, writes a draft with its normal tools, then runs
`./node_modules/@b00dea/cockpit/bin/cockpit.mjs env schema --config cockpit.toml --path <schema reference> --replace-from <draft>`.
The result is
[not validated until it is committed](environment.md#a-schema-runs-only-once-committed), and
committing is the guarded checkpoint, so an edit here is not itself a security boundary.

The command refuses a draft whose path has a segment that is `.secrets` or starts with `.env`, under
any case folding; a declared instance or other location the guard protects; a symbolic or hard link;
anything but a regular file; and a file over the bound. Otherwise `--replace-from .env` followed by
`env schema` would print a secret. It refuses a target that is a link too, and replaces the bytes
atomically, or creates a missing schema in a discovered directory or in a sibling component that
[adopts its first schema](environment.md#read-variable-names-and-schemas).

| Writing `.env.schema`, cockpit root and sibling | Guard evaluator, 2026-11-05 |
| --- | --- |
| `apply_patch`, adding or updating | allow |
| `Edit`, `Write` | allow; Claude Code's native rules refuse them, as measured above |
| `env schema --replace-from` with a safe draft, alone | allow |
| that command compounded with `&&`, `;` or a pipe, or with a redirect | ask |
| `cp`, `mv` or `printf ... >>` onto that name | ask, which a tool with no prompt tier refuses |

The evaluator's answers do not show that a harness routes its tool through the guard, so these were
also driven against a synthetic project installed from the package tarball, with a loopback model:

| Measured | Result |
| --- | --- |
| Claude Code 2.1.318, generated settings and guard, 2026-11-05 | `env keys`, `env schema` and `--replace-from` with a draft from the Write tool ran without a prompt. `--replace-from .env` needed approval and `cat .env` was refused by the guard. A sentinel in `.env` appeared nowhere in the output. |
| Codex CLI 0.166.0, hook not trusted, 2026-11-05 | The same commands ran. So did `cat .env`, which printed the sentinel: Codex skips an untrusted hook, which is why [the hook must be trusted](harness-surfaces.md#trust-the-codex-hook) before a session near real secrets. |
| Generated Codex guard run directly on Codex-shaped calls, 2026-11-05 | Allowed `env keys`, `env schema`, a safe `--replace-from`, `cat .env.schema` and an `apply_patch` of the schema. Denied `--replace-from .env`, `cat .env`, an `apply_patch` of `.env` and a shell-written draft. This does not show Codex routing a call through a trusted hook. |

OpenCode, Cursor and Grok were not driven. Cursor and Grok have no generated guard, so nothing here
is enforced for them. The native results are dated and limited to those versions.

## Who decides

`[autonomy]` and `[work.gates]` in `cockpit.toml` say who takes each decision cockpit gates:
`agent`, `person` or `ci`. `[work] grading` says how a work order earns done; the work-order fields
are in [Who passes each gate](work-and-browser.md#who-passes-each-gate).

Each gate is one of two kinds. A **guardrail** keeps the agent from escaping or weakening a
constraint on itself: widening what it may run, read or write, loosening its own grading or tests,
approving its own access, hiding evidence or undoing a guard. A guardrail stays a person's in every
configuration. A **process gate** adds a person's step but no protection against the agent, so a team
may hand it to the agent. Handing one over is itself a guardrail: the fields that delegate are pinned
against agent edits and a loosened one is held until a person accepts it, so only a person who edits
`cockpit.toml` and syncs can turn a gate over.

The shipped defaults sit in the middle: an agent does routine work without asking, and deleting
data, starting a new MCP server and widening access stay a person's. Each row also shows the
stricter setting and the most agentic one that keeps every guardrail.

| Gate | Kind, and why | Setting | Shipped | Person approves more | Most agentic |
| --- | --- | --- | --- | --- | --- |
| A writing `sync` | process: the guard admits an agent's sync only for an edit that does not widen; under `ci` it runs only where `CI` is set | `[autonomy] sync` | `agent` | `person` or `ci` | `agent` |
| `sync` removing a file it generated before and no longer generates | process: the file is cockpit's own output; an unchanged MCP-only file of a listed tool whose servers are no longer written never waits, because removing it only narrows access | `[autonomy] stale_delete` | `agent` | `person` | `agent` |
| `reset --apply`, and a `stacks prune --apply` that deletes volumes | process: it deletes local stack data, which bring-up recreates, and loosens no constraint; otherwise a person approves the preview with `--interactive` | `[autonomy] reset` | `person` | `person` or `ci` | `agent` |
| Accepting, answering and signing off a work order | process: the grade still judges the work | `[work.gates] accept`, `answer`, `signoff` | `agent` | `person` or `ci` | `agent` |
| Amending an accepted contract | process for a rewrite the next grade judges; removing an accepted criterion or gate, or a rewrite under `checks` grading, which nothing judges, is a guardrail and needs a person or CI whatever the field says | `[work.gates] amend` | `agent` | `person` or `ci` | `agent` |
| Acknowledging a test weakening | process where a model grades, which reads the acknowledgement as context; under `checks` grading the acknowledgement alone passes the test-protection check, so there it is a guardrail and needs a person or CI whatever the field says, and an acknowledgement the agent recorded under another mode does not count | `[work.gates] acknowledge` | `agent` | `person` or `ci` | `agent` |
| Confirming an init answer that is no trust decision: `cockpit.name`, `estate.runnable`, `environment.test_data` | process: confirming changes no value, and the record names the agent and the field that let it decide | `[autonomy] confirm_answers` | `person` | `person` | `agent` |
| `setup --write-instruction-files` and `--write-instruction-pointers` | process: they write sibling instruction files the agent may already edit with its own tools | `[autonomy] instruction_files` | `person` | `person` | `agent` |
| `browser drive` and `screenshot` without a prompt | process on isolated data; on data that is not isolated, restored or reaches production, preapproval is refused | `[browser] request_preapproval` | on exactly where the data is isolated | `false` | as shipped |
| Enabling a declared MCP server | guardrail: a harness starts an enabled server outside every guard boundary, and a sibling's MCP source is a file the agent can write. `agent` exists, and gives this guardrail up | `[autonomy] mcp_approve` | `person` | `person` | `person` |
| Starting a profile that mounts an operator-gated sibling | guardrail: it touches live data or local hardware | `gate = "operator"` on the sibling | as declared | add the gate | keep the gate |
| A command the guard asks about | guardrail: under the shipped allow default a program the guard does not know, inline interpreter code, or a boundary it cannot resolve, such as a push whose destination Git cannot name; under `[guards] default = "ask"` every command it cannot prove safe. A person admits a command for good under `[[guards.allow]]`, which never overrides a blocked item | `[guards] default`, `[[guards.allow]]` | `allow`: a prompt in Claude Code, a refusal in Codex and OpenCode | `ask` | `allow` |
| An edit of `cockpit.toml` that widens what agents may do (`GUARD_CONFIG_WIDENED`) | guardrail: it widens what the agent may run, read or write; [Edits the guard has not applied](#edits-the-guard-has-not-applied) | none | a person, at `sync --interactive` | | |
| An agent's edit of `[work]`, `[work.gates]`, `[autonomy]` or MCP tool access | guardrail: it is how an agent would delegate to itself; the edit is a hard denial | none | refused | | |
| Accepting a weaker policy than the last sync recorded, grading mode included (`POLICY_WEAKENING_UNCONFIRMED`) | guardrail: it loosens the agent's own gates or grading; this covers moving grading off a grader that cannot run (`EVALUATOR_UNAVAILABLE`) | none | a person, at `sync --interactive` | | |
| Confirming a trust answer: `guards`, `testing`, `environment.install_policies`, `sibling`, `work.grading`, `environment.posture` | guardrail: an agent confirming one would hide that no person reviewed what constrains it | none | a person | | |
| Reading secrets and declared instances, writing guard controls, pushing to protected branches | guardrail: hard denials no rule or setting relaxes | none | refused | | |
| Trusting Codex's hooks, trusting a workspace in Claude Code, signing in to a secrets provider | outside cockpit: only the person's own tool grants them; `doctor` and `check` report missing Codex hook trust as `CODEX_HOOK_UNTRUSTED`, and cockpit cannot observe the other two | none | a person | | |
| The required `work verify` job behind a protected environment's reviewers | guardrail: its point is a run the agent does not control | none | CI reviewers | | |

### Fully agentic setup

The most agentic configuration that keeps every guardrail. A person writes it into `cockpit.toml`,
runs `sync --interactive` once, reviews the weakening and confirms it with `yes`, because `reset`,
`confirm_answers` and `instruction_files` move from `person` to `agent`:

```toml
[work]
grading = "independent"

[work.gates]
accept = "agent"
amend = "agent"
answer = "agent"
signoff = "agent"
acknowledge = "agent"  # under "checks" grading a person or CI acknowledges regardless

[autonomy]
sync = "agent"
stale_delete = "agent"
reset = "agent"
confirm_answers = "agent"
instruction_files = "agent"
mcp_approve = "person"  # "agent" would let an agent start processes outside the guard
```

<!-- cockpit:ref path=packages/cockpit/src/guards/policy-pin.ts --> The guard pins the policy: an
agent's edit, write or patch that would change `[work]`, `[work.gates]` or `[autonomy]`, or widens
MCP tool access, is a hard denial. MCP server approvals are also pinned while `mcp_approve` is
`person`; delegating server approval does not delegate permission to remove tool restrictions.
Removing unchanged MCP approvals and adding or narrowing exact tool allowlists is permitted.

The guard applies the edit to the current text and compares the tables, so an edit elsewhere in the
file stays permitted; an edit it cannot apply exactly, and a shell command that names the file and
can visibly write it (a redirect onto it, a writer such as `cp`, `mv`, `tee` or `git checkout`, an
in-place `sed -i` or `perl -i`, or a write option such as `-o` or `--output`), are denied. A command
that only reads it, such as `diff`, `sort` or `cockpit check --config cockpit.toml`, is not. The
pin holds only for the tool calls the guard inspects.

Every writing `sync` records the policy it ran under in `.cockpit/policy.json`. A later sync that
finds a field weaker than that record, such as a gate moved from `person` to `agent` or grading from
`independent` to `self`, writes nothing and reports `POLICY_WEAKENING_UNCONFIRMED` with the change
and its digest; a person runs `sync --interactive`, reads it and confirms with `yes`. `check` and
`doctor` report the same weakening. Until then every work command refuses to run under the weaker
policy, and so does `reset --apply` when `[autonomy] reset` is the weakened field. A stronger policy
needs nobody.

A local `person` gate is best-effort: cockpit cannot tell a person from a program driving a
terminal. `ci` relies on the `CI` variable, which an agent can set too, so locally it is best-effort
as well. The only enforced human gate is a required CI job behind a protected environment whose
reviewers must approve it, such as the
[`work verify` job](work-and-browser.md#who-passes-each-gate).

### Edits the guard has not applied

<!-- cockpit:ref path=packages/cockpit/src/guards/policy-change.ts --> Once `cockpit.toml` differs
from the configuration the guards were generated from, the guard compares it, with defaults applied,
to the copy sync keeps in `.cockpit/local/guard-config`. An edit that does not widen what agents may
do is judged as written: the guard applies the current configuration at once, so a new deny rule or
protected branch takes effect on the next call, and `check` reports the edit as
`GUARD_CONFIG_UNSYNCED` until sync records it. An edit that widens is not applied: the guard keeps
judging every call under the configuration last synced, as `.cockpit/local/guard-config` records
it, so the agent keeps working and the widened rule is not yet in force. While it waits, an agent's
`cockpit sync` or `cockpit upgrade` is refused, the policy pin still applies to the current text,
and every refusal ends with a sentence naming the widened fields and `sync --interactive`.

Sync itself refuses to publish a widening that nobody confirmed (`GUARD_CONFIG_WIDENED`), whoever
runs it: a person runs `sync --interactive`, reads the widened fields and answers `yes`. Sync judges
the exact bytes it publishes, so an edit made while it runs is judged too. An `init` rerun is gated
the same way, and `sync --adopt` may add only adopted-surface rows. The first sync on a machine,
before any guard is recorded, runs unattended. As with every local `person` gate, cockpit cannot
tell a person from a program driving a terminal.

An edit whose configuration does not load, and a missing or mismatched recorded copy, hold every
guarded call until a person syncs. A guarded call is one a generated hook fires on: shell commands,
file edits and writes, and restricted MCP tools under Claude Code. A hold stops nothing else, so
file reads and unrestricted MCP tools continue.

Sync can refuse an edit the guard admitted, such as a tool restriction naming an undeclared server.
So the hold on a file that does not load admits one edit, write or patch of `cockpit.toml` itself
that leaves it byte-identical to the recorded copy. An agent can restore only what was recorded, so
authority never exceeds the recorded policy, and this may also discard a person's unsynced narrowing
edit. An edit the guard cannot prove applies exactly once, or that also touches another file, stays
held. The same restoration is admitted out of a widening edit, which leaves agents under the policy
they already had.

An edit does not widen only when every difference is one of these:

- descriptive or host-only fields: a sibling's `purpose`, `host_reason` and `rebuild_inputs`,
  `cockpit.guide_cap`, `[ports]`, `environment.entrypoint_derivatives`, `environment.machine` and
  `docs.living`;
- added agent tools, `unconfirmed` answers and sibling operator gates;
- removed Compose files, Compose profiles and resettable volumes, and an install policy that admits
  no command it did not;
- removed guard allow rules and unchanged MCP approvals, added or narrowed MCP tool allowlists;
  added guard deny rules, protected branches, hosted database hosts and vendor endpoint hosts;
- any change to `[mcp.approved]` while `mcp_approve = "agent"` in both configurations.

Every other difference widens. That includes any change, in either direction, to `[work]`,
`[autonomy]`, `[testing]` (whose stages `test-run` runs unprompted) and `[browser]`; new or changed
MCP approvals outside that delegation, removed or expanded MCP tool allowlists, new guard allows or
removed guard restrictions; a new sibling; a sibling's changed `dir`, `guides`, environment files or
derived MCP sources; and every command field, such as `environment.seed`. A field the classification
has no rule for widens too. A missing or mismatched copy of the generated configuration holds every
guarded call. `check` reports the same classification: `GUARD_CONFIG_UNSYNCED` as a warning,
`GUARD_CONFIG_WIDENED` as an error naming the fields.

Whoever runs it, sync refuses a guide that is, or links to, a `.env` or `.env.*` file, a file below
a `.secrets` directory or a declared environment instance (`PROJECTION_GUIDE_SECRET`), so a guide
never copies what the guard keeps from agents into the root `AGENTS.md`.

## Native adapter behavior

The [transport and adapter owner](../packages/cockpit/src/guards/harness-adapter.ts) translates a
decision without adding grants or weakening hard boundaries:

| Harness | Translation and adapter exit |
| --- | --- |
| Claude Code | Allow, ask, and deny exit 0; ask and deny are carried in native decision JSON. |
| Codex CLI | Ask becomes deny, because Codex hooks have no prompt tier, and a decision a human cannot be shown must not let the call run. Allow and deny exit 0; deny is carried in native decision JSON. |
| OpenCode | Ask becomes deny, for the same reason: its plugin hook can only throw or continue. Allow exits 0; every non-allow decision exits 2. |

Unavailable or malformed decisions exit 2 on every target, so adapter exit 0 alone does not mean
permission was granted. The generated Claude Code and Codex registrations give the guard hook a
`timeout` of 30 seconds; a guard call spawns several Node and Git processes and was seen to exceed
Codex's 5-second default on a loaded machine. What either harness does with the call when that
timeout fires, run it or refuse it, is not measured. So the guard keeps its own deadline of 25
seconds: a call still undecided then is refused (`GUARD_TIMED_OUT`, exit 2), the guard stops every
process it started, and it starts nothing after. A synchronous stall inside the guard's own process
can still reach the harness timeout, which may then fail open;
copied plans, failed transport, signals, oversized output, nonzero handler status and invalid JSON
become `unavailable` with exit 2. Lexical path normalization in this adapter does not itself verify
filesystem identity.

If an adapter is unavailable, no target-specific registration or read-only fragment is emitted; the
shared guard file may still be generated. What each harness is confirmed to enforce is in
[Capability states](harness-surfaces.md#capability-states).

## Evidence

Static configuration, source inspection, synthetic fixtures, model self-report and silence do not
prove native enforcement. The
[native evidence validator](../packages/cockpit/libexec/validate-harness-evidence.mjs) binds exact
current executable and wiring identities, generated-manifest and candidate digests, version, bounded
transcripts and validation results, and each record carries candidate and deliberately
broken-control evidence.

Missing evidence keeps a cell `instructed` or `unavailable`, with `human_needed` judgments still
pending. It never relaxes a hard denial or grants a permission. Switching defaults, deleting
fallbacks and publishing stay human decisions; a green source check or a generated reference does
not make them.
