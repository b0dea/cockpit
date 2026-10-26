# Security policy

<!-- cockpit:verified version=0.0.0 -->

## Supported versions

| Version | Supported |
|---|---|
| the newest minor | yes |
| everything older | no |

Security and bug fixes land on the newest minor release, and only there. There is no long-term
support branch and no backporting; upgrading to the newest minor is the fix.

Nothing has been published yet — the package sits at `0.0.0` and has never been released. The
policy above applies from the first release onward.

## Reporting a vulnerability

**A vulnerability never goes to the public issue tracker first.**

<!-- cockpit:operator-evidence private-reporting-channel=pending -->

The repository's private reporting channel has not yet been verified live, so this policy does not
name or link a channel that may not exist. Enabling the channel, submitting a private test report,
and confirming its receipt are publication gates. Until that evidence exists, a public issue may
state only that the private route is unavailable; include no vulnerability details.

The same applies to fixes: do not open a pull request whose diff or message explains the
vulnerability before there is a release. A public fix is a disclosure.

Useful in a report: what an attacker can do, the smallest reproduction you have, the versions
involved (cockpit, Node, operating system, and which agent tool if it is relevant), and whether
you intend to publish. A synthetic reproduction is fine and preferred — this project cannot
accept material that identifies someone's private deployment, even in a security report.

## What to expect

There is one maintainer and no on-call rotation. These are the windows this project can
actually keep, which is why none of them is measured in hours:

| | |
|---|---|
| Acknowledgement | within 7 days |
| First assessment — is it a vulnerability, and how bad | within 14 days of acknowledgement |
| Fix | no fixed window; a confirmed high-severity issue is the next thing worked on, lower severity ships with the next release |

If you have had no acknowledgement after 14 days, send the report again rather than assuming it
was received and ignored. Reports do get lost.

You will be told what was concluded, including when the conclusion is that it is not a
vulnerability and why.

## Disclosure

Coordinated. Once a fix is released, the advisory is published and the changelog says a
security fix landed and what it affected. If no fix has shipped **90 days** after
acknowledgement, you are free to publish; ask sooner if you have a deadline and it will usually
be agreed.

Reporters are credited in the advisory unless you ask not to be.

## Consumer-identifying leaks

Consumer-identifying material found after publication is handled as a vulnerability. The response
removes it from the current tree, rotates any affected credentials or endpoints, and republishes
from a clean root when repository history carries the material. Known downstream forks or vendored
copies are notified through their private security routes.

Registry retraction, Git rewrites, and cache invalidation cannot guarantee that every downloaded or
forked copy disappears. The advisory states what was exposed, which versions or commits carried it,
what was rotated, and what consumers must replace; it does not promise erasure that cannot be
verified.

## Scope

In scope — the parts of this project that run on someone else's machine:

- the CLI and everything it writes;
- the surfaces in `packages/cockpit/surfaces/` and the files rendered from them into a
  consumer's repository;
- the guards and hooks, and the generated per-harness configuration.

The highest-value place to look is anywhere cockpit writes into a repository or generates
configuration that an agent tool then executes: that is a supply-chain persistence surface, and
it is the reason the write path is confined, the allow-lists are enumerated, and deletion is by
name rather than by pattern. A path that escapes its tree, a generated permission that grants
more than it reads as granting, or a restriction that is emitted and binds nothing are all
security defects here, not merely bugs.

Out of scope:

- a consumer's own product repositories, their deployments and their secrets — cockpit boots
  them, it does not own them;
- vulnerabilities in third-party agent tools, container runtimes or dependencies. Report those
  upstream; tell us as well if we should pin, patch or route around them.
