---
"@b00dea/cockpit": patch
---

A generated browser runner now reaches the application, and `up` completes with one.

- `browser drive` and `browser screenshot` against a generated runner failed every navigation, because the container's browser looked for the host's `127.0.0.1` and `localhost` URLs on its own loopback. The runner now serves Playwright in a mode that honours `browser.network_exposure`, so those URLs, and `.localhost` names, travel back through the command's own process and open exactly what a person opens. An origin outside the exposure is refused before the browser starts.
- `up` with a runner refused with "generated environment observations are incomplete" although every container was healthy: the runner's image check named a host executable cockpit never authenticates. The runner now checks its architecture from inside the container.
- A failed navigation names the route's URL and the browser's error code, so a stopped application reads "nothing answered at <url>" with the command to check the stack.
- Each refusal while declaring `[browser]` names the missing piece and its fix: the playwright MCP declaration, its approval, its working directory and endpoint argument, the browser project's digests and pinned driver, the proxy host variable, and running `up` before `sync`. A generated runner refuses resolver rules other than `.localhost` names mapped to loopback, and no longer gives its container host aliases that pointed at its own loopback.
- The runner installs the browser project with `npm ci --prefer-offline`, so a restarted runner reuses npm's download cache without contacting the registry; integrity checks against the lockfile are unchanged.
- `examples/minimal` has a worked `cockpit.browser.toml`, and "Declare a browser" in the work and browser guide lists every requirement.
