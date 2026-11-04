---
"@b00dea/cockpit": patch
---

Browser route findings are evidence, not a gate. `browser drive` with findings now exits 0 and carries `verdict: findings` with the full receipt; `--fail-on-findings` restores exit 2 (`BROWSER_ROUTE_FINDINGS`) for a criterion that wants a clean route. Each route also carries an `excerpt` of up to five console and uncaught error messages, 240 bytes each, tagged `untrusted-page-content`, so a favicon 404 can be told from a broken API call. The excerpt is read only when `[browser.data]` is isolated, not restored and not reaching production; otherwise it is omitted with the reason.

`browser.request_preapproval` now defaults to on when `[browser.data]` qualifies for it and to off otherwise; an explicit value still wins, and `true` on a posture that does not qualify is still refused.

The command after `cockpit exec --service <s> --` runs in the container's filesystem, so the guard no longer proves it read-only: it stays subject to the name-based denials and is admitted only by a `[guards] allow` rule or a declared build or test command, and otherwise asks.

`init` lists the `COMPOSE_IMAGE_TAG_SHARED` finding beside the other Compose findings.
