# Security policy

## Supported versions

Fixes land on the newest minor release only; upgrading to it is the fix. There is no long-term
support branch and no backporting.

## Reporting a vulnerability

**Never report a vulnerability in a public issue, pull request or discussion.** A public fix whose
diff or message explains the problem is a disclosure too.

<!-- cockpit:operator-evidence private-reporting-channel=enabled -->

Report it privately through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**.

A useful report gives what an attacker can do, the smallest synthetic reproduction (the project
cannot accept material that identifies someone's private deployment, even in a security report),
the versions involved, and whether you intend to publish.

## What to expect

There is one maintainer and no on-call rotation, so these windows are in days:

| | |
|---|---|
| Acknowledgement | within 7 days |
| First assessment: is it a vulnerability, and how bad | within 14 days of acknowledgement |
| Fix | no fixed window; confirmed high severity is worked on next, lower severity ships with the next release |

With no acknowledgement after 14 days, send the report again. You will be told the conclusion,
including why when it is not a vulnerability.

## Disclosure

Coordinated. Once a fix is released the advisory is published, crediting the reporter unless they
ask otherwise. If no fix has shipped **90 days** after acknowledgement, you are free to publish;
ask sooner if you have a deadline.

## Consumer-identifying leaks

Consumer-identifying material found in the published tree or history is handled as a
vulnerability: it is removed from the current tree, affected credentials or endpoints are rotated,
and the repository is republished from a clean root when history carries it. Known downstream
forks are notified through their private security routes.

Registry retraction, Git rewrites and cache invalidation cannot guarantee that every downloaded or
forked copy disappears, so the advisory promises no erasure. It states what was exposed, which
versions or commits carried it, what was rotated, and what consumers must replace.

## Scope

In scope is what runs on someone else's machine: the CLI and everything it writes, the surfaces in
`packages/cockpit/surfaces/` and the files rendered from them, and the guards, hooks and generated
per-harness configuration.

The highest-value place to look is anywhere cockpit writes into a repository or generates
configuration that an agent tool then executes. These are security defects here, not merely bugs:

- a path that escapes its tree;
- a generated permission that grants more than it reads as granting;
- a restriction that is emitted and binds nothing.

Out of scope:

- a consumer's own product repositories, deployments and secrets: cockpit boots them, it does not
  own them;
- vulnerabilities in third-party agent tools, container runtimes or dependencies. Report those
  upstream, and tell us as well if we should pin, patch or route around them.
