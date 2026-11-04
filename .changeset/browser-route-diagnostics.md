---
"@b00dea/cockpit": patch
---

`browser drive` now reports what each route's page did wrong, not only that it loaded: console errors, uncaught page errors, and failed or 4xx/5xx requests to the application's own origin, with method, URL path (no query) and status, plus counts of warnings, aborted requests and third-party traffic. Each route gets a `clean` or `findings` verdict, at most 20 entries are kept per route, and message text, bodies, headers and cookies are never read. With `--fail-on-findings` a drive with findings exits 2 with `BROWSER_ROUTE_FINDINGS`, so it works as a work-order criterion check that demands a clean route; without it the findings are evidence and the drive exits 0. `--route <name-or-path>` drives or captures a single declared route.
