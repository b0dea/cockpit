# Contributor documentation

<!-- cockpit:verified version=0.0.0 -->

These pages are for people working on cockpit itself: how its documentation is written and
tested, how releases happen, and the contracts that span several modules. Setup and the pull
request rules are in [CONTRIBUTING.md](../../CONTRIBUTING.md).

## Policies and contracts

- [Documentation style](style.md)
- [Releasing](releasing.md)
- [Testing harness surfaces](testing.md)
- [CLI completion and generated references](cli-completion-and-references.md)
- [Normative contracts](decisions/README.md)

The linter checks each `cockpit:ref path=` marker against the tracked code it points to. A claim
that something is enforced but carries no marker is for a reviewer to catch; the linter cannot
find it in free prose.
