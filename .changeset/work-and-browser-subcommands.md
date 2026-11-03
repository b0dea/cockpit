---
"@b00dea/cockpit": patch
---

Work-order and browser commands are subcommands, and `cockpit --help` is grouped by stage.

- The work-order commands are `cockpit work <subcommand>` (`work status`, `work accept`, `work check`, `work note`, `work answer`, `work grade`, `work signoff`, `work recover`, `work verify`), and the browser commands are `cockpit browser <subcommand>` (`browser drive`, `browser screenshot`, `browser debugger`). Options are unchanged. A hyphenated spelling such as `work-grade` is refused with `CLI_UNKNOWN_COMMAND`, which names the spelling that runs.
- `cockpit --help` lists the commands under Set up, Generate and verify, Run the stack, Diagnose, and Test and grade, with `work` and `browser` as one entry each; `cockpit work --help` and `cockpit browser --help` list their subcommands. A group run without a subcommand is refused with `CLI_COMMAND_REQUIRED`, which lists them.
