# Contributor documentation

<!-- cockpit:verified version=0.0.0 -->

These pages are for people working on cockpit itself: how its documentation is written, how
releases happen, and the contracts that span several owners. They are kept apart from the user
guides because the two have different readers.

## Policies and contracts

- [Documentation style](style.md)
- [Releasing](releasing.md)
- [Normative contracts](decisions/README.md)

The linter authenticates structured `cockpit:ref path=` declarations against tracked mechanisms.
Finding an enforcement claim that has no declaration is review judgment, not a free-prose check.
