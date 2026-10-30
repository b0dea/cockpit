# Contributor documentation

<!-- cockpit:verified version=0.0.0 -->

These pages are for people working on cockpit itself: how its documentation is written, how
releases happen, and the rules that apply across several modules. They are kept apart from the user
guides because the two have different readers.

## Policies and contracts

- [Documentation style](style.md)
- [Releasing](releasing.md)
- [Testing harness surfaces](testing.md)
- [Normative contracts](decisions/README.md)

The linter checks each `cockpit:ref path=` marker against the tracked code it points to.
Spotting a claim that something is enforced but has no marker is a reviewer's job; the linter cannot do it from free prose.
