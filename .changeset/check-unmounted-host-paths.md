---
"@b00dea/cockpit": patch
---

`check` fails with `GENERATED_HOST_PATH_UNMOUNTED` for an `environment.generated_host_paths` entry that no service bind-mounts, naming the entry and how to fix it. In compose-first mode `up` already refused such a stack, and now `check` says so first. An entry inside a bound directory, such as a sibling mounted whole, reaches the container through that bind and counts as mounted; compose-first `up` no longer refuses it either.
