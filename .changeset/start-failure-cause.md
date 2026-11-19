---
'@b00dea/cockpit': patch
---

When a service fails to start, `up`, `restart` and `rebuild` now say why, for example that Docker could not bind a port another process holds or that the container is unhealthy. Before, they reported only that the service did not become healthy, plus a note that its logs were empty.
