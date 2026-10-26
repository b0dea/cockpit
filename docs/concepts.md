# Concepts

<!-- cockpit:verified version=0.0.0 -->

This vocabulary is for operators and integrators reading cockpit configuration, output, and
diagnostics. Each defined term has one meaning throughout the maintained documentation.

## Cockpit checkout root

The directory that contains <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` and identifies one cockpit instance. Relative generated
paths, local state, and lifecycle commands are resolved from this directory.

## Cockpit sibling declaration

One configured product repository, including its stable slug, path, acquisition mode, mount mode,
toolchain, and projected guidance. A declaration identifies a repository; it does not prove that
the checkout exists or is healthy.

## Cockpit product registry

The optional, validated description of an established product's repositories, environment,
surfaces, guards, grading, and adoption state. It is an input to discovery, not a substitute for
the generated <!-- cockpit:ref consumer=cockpit.toml --> `cockpit.toml` draft or its human review.

## Cockpit lifecycle record

Persisted state binding one checkout and shared runtime to completed setup and bring-up stages.
Later commands use it to resume safely and to distinguish a current observation from an earlier
attempt.

## Cockpit generated ownership

The authenticated inventory of whole files, symlinks, and delimited shared-file regions published
by cockpit. It permits drift detection and bounded replacement without treating unmanaged bytes as
cockpit output.

## Cockpit harness capability state

The measured status of one feature for one agent harness: `enforced`, `instructed`, or
`unavailable`. Generated configuration alone does not promote a feature to `enforced`.

## Cockpit surface overlay

A product-specific addition or explicit hash-bound replacement for generated rules, subagents,
skills, or hooks. It cannot replace core permissions or MCP authority.

## Cockpit evidence boundary

The line between what a named owner has authenticated and what still requires a current native,
human, vendor, or runtime observation. Evidence from a repository test cannot cross that line by
being restated as prose.
