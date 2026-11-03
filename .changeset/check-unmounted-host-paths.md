---
"@b00dea/cockpit": patch
---

`check` fails with `GENERATED_HOST_PATH_UNMOUNTED` for an `environment.generated_host_paths` entry that no service bind-mounts, naming the entry and how to fix it. In compose-first mode `up` already refused such a stack, and now `check` says so first. In a generated stack the entry used to be accepted and hand nothing to a container; an entry that is a `[browser]` artifact root is still accepted, because the browser commands write there.
