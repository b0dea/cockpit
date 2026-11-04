---
"@b00dea/cockpit": patch
---

Compose profiles now activate. `[environment] profiles` lists the profiles every `up` and `session`
starts, and `up --profile <name>` (repeatable, also on `session`) adds more for a run. The stack
records its profile set, so `down`, `sleep`, `logs`, `preflight` and the service verbs act on the
same services, and a `profile:<name>` sibling is mounted while its profile is active. A profile no
service declares is refused with `COMPOSE_PROFILE_UNDEFINED`; adding a profile to a running stack
is refused like any other change, so run `down`, then `up --profile <name>`.

New service verbs act on this checkout's own stack without naming its Compose project: `ps`,
`restart --service <name>`, `rebuild --service <name>` and `exec --service <name> -- <command>`.
The guard admits them like `up`, and judges the command after `exec --` as a host command.

`check` refuses a built service with a fixed `image` tag (`COMPOSE_IMAGE_TAG_SHARED`), because one
checkout's build replaced the image another checkout's stack ran, and now judges bind mounts of
profile-gated services under their profiles instead of refusing them.

Upgrade: run cockpit sync, so Claude Code may run the new verbs without asking.
