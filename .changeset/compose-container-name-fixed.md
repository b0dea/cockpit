---
"@b00dea/cockpit": patch
---

`cockpit check` now refuses a Compose service that sets `container_name`. Docker allows one container
of a name, so the second checkout's `up` failed at runtime, which breaks the one-stack-per-checkout
promise; the finding is `COMPOSE_CONTAINER_NAME_FIXED`, an error like `COMPOSE_PORT_NOT_LEASED`, and
`init` shows it beside the drafted `cockpit.toml`. The install instructions now name the pnpm and
yarn equivalents.

Upgrade: remove `container_name` from each Compose service `check` names and address the service by
its Compose service name or `docker compose exec <service>`.
