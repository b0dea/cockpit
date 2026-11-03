---
"@b00dea/cockpit": patch
---

`browser.endpoint` is no longer refused outright: it must be a loopback `ws://` address whose port exactly one service in `environment.compose_files` publishes on loopback, otherwise sync refuses with `GENERATED_BROWSER_ENDPOINT_UNPUBLISHED`.
