# Cockpit documentation

This index lists every page for people using cockpit on their own products, grouped by what you
are trying to do. To work on cockpit itself, start with [CONTRIBUTING.md](../CONTRIBUTING.md); the
contributor pages live separately under docs/contributing/.

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
- [Extending cockpit](extending.md): supported extension points, what an upgrade replaces and the build-beside pattern.
- [Safety and autonomy](safety-and-autonomy.md): what guards allow, ask about and deny.
- [Work and browser workflows](work-and-browser.md): work orders, grading, browser checks and
  test tiers.

## Reference

The command list, CLI reference, configuration reference and capability matrix are generated from
the source and change with it. Troubleshooting combines hand-written recovery guidance with a
generated diagnostic index.

- [Configuration essentials](configuration-essentials.md): the tables a typical `cockpit.toml`
  sets, each linked to its full reference entry.
- [Command list](command-list.md)
- [CLI reference](cli-reference.md)
- [Configuration reference](configuration-reference.md)
- [Capability matrix](capability-matrix.md)
- [Troubleshooting](troubleshooting.md): hand-written remedies followed by the generated table
  of codes with a fixed remedy.

## Examples

Each example is a cockpit you can copy and run; its README gives the exact commands.

- [examples/synthetic](../examples/synthetic/README.md): two throwaway repositories, from
  configuration to a drift check, with no Docker.
- [examples/minimal](../examples/minimal/README.md): one service, one port and one health probe,
  for a running stack.
- [examples/compose-first](../examples/compose-first/README.md): a cockpit that keeps its own
  `compose.yml`.
- [examples/docs-only](../examples/docs-only/README.md): no environment, for a repository of
  documents or a product not yet built.
- [examples/extended](../examples/extended/README.md): a custom Compose service and
  product-specific checks kept beside cockpit.

## Background

- [Architecture and design](architecture.md): why cockpit is shaped this way, non-goals, and
  extension seams.
- [Release policy](release-policy.md): supported runtimes, deprecation and migration.
