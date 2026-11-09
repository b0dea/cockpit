---
"@b00dea/cockpit": patch
---

The guard no longer lets a launcher, a quoting trick or a git subcommand hide the command that runs:

- zsh's `-` precommand is read as a wrapper, so `- git push --force origin main` is judged as the push behind it.
- A package launcher is followed into the program it runs: `npx`, `npm exec` and `npm x`, `pnpm exec`, `pnpm dlx`, `pnpx`, `yarn exec`, `yarn dlx`, `bunx`, `bun x`, `bun run`, `uvx`, `uv tool run`, `uv run`, `poetry run`, `pipenv run`, and `pnpm <program>`, which pnpm runs as `pnpm exec` when the word names none of its own commands. The launcher is still judged as written, so a rule naming it keeps applying, and the program after it is judged as a wrapped command. A launcher option the guard does not read, such as `npx -c` or `pnpm exec -c`, is refused, as are `npm exec` and `yarn exec` with options after the program and no `--` before it, pnpm options that choose another directory or workspace packages for a program, and `pnpm with`. `npx --no cockpit` and the other cockpit launcher spellings are unchanged.
- `script`, `flock`, `parallel` and `entr` are refused like `watch`: each runs the rest of its line in a form the guard does not read.
- `git rebase --exec` (also `-x` and abbreviations), `git bisect run` and `git submodule foreach` are refused with a way forward: git runs their command from the top of the working tree or inside each submodule, not where the guard judges it.
- A command that sets HOME or CDPATH with quotes inside the name, such as `export HO''ME=…`, or that hands `export`, `declare`, `read` or another variable-setting builtin a name the guard cannot see, no longer gets the hook's HOME or CDPATH applied to its `~` and `cd`. This also holds inside a `sh -c` string.
- A download piped into `awk`, `gawk`, `mawk`, `nawk`, `nodejs`, `bun`, `deno`, `tclsh`, `lua` or `Rscript` is refused as downloaded code, and so are `deno` given a URL and a launcher whose package is a URL or a Git source such as `github:owner/repo` or `owner/repo`. A package from a registry is judged by the program it runs, as installing a dependency is.
