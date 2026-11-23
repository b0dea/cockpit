---
'@b00dea/cockpit': patch
---

`cockpit session` no longer refuses its command because a service it may not need is unhealthy: it starts every service that does not depend on the unhealthy one, runs the command, and names each service it runs without in a `SESSION_SERVICES_UNHEALTHY` warning. A session still refuses a stack with no healthy service, and a plain `up` still refuses until every service is healthy.
