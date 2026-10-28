# Cockpit documentation

<!-- cockpit:verified version=0.0.0 -->

This index lists every page for people using cockpit on their own products, grouped by what you
are trying to do. Contributor documentation lives separately under docs/contributing/.

## Learn

- [Tutorial](tutorial.md): run the synthetic example end to end.
- [Getting started](getting-started.md): install cockpit and bring up your own product.
- [Agent adoption guide](agent-adoption.md): the situations and exact commands for an AI agent
  setting cockpit up, with the safety contract it works under.
- [Concepts](concepts.md): the glossary and the terms diagnostics use.
- [FAQ](faq.md): short answers, including when not to use cockpit.

## Guides

- [Incremental adoption](adoption.md): move an existing setup over one layer at a time.
- [Joining a team's cockpit](joining-a-team.md): install and verify a cockpit from a fresh clone.
- [Environment lifecycle](environment.md): setup, generation, bring-up, health, logs and reset.
- [Harness surfaces](harness-surfaces.md): what `sync` writes for each agent tool, and overlays.
- [Extending cockpit](extending.md): supported seams, upgrade ownership and the build-beside pattern.
- [Safety and autonomy](safety-and-autonomy.md): what guards allow, ask about and deny.
- [Work and browser workflows](work-and-browser.md): work orders, grading, browser evidence and
  test tiers.

## Reference

The first four pages are generated from the source and change with it. Troubleshooting combines
hand-written recovery guidance with a generated diagnostic index.

- [Command list](command-list.md)
- [CLI reference](cli-reference.md)
- [Configuration reference](configuration-reference.md)
- [Capability matrix](capability-matrix.md)
- [Troubleshooting](troubleshooting.md): hand-written remedies followed by the generated
  diagnostic index.

## Background

- [Architecture and design](architecture.md): why cockpit is shaped this way, non-goals, and
  extension seams.
- [Release policy](release-policy.md): supported runtimes, deprecation and migration.
