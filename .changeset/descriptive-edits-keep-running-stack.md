---
"@b00dea/cockpit": patch
---

Rewording a generated stack's prose no longer forces `down` before `up`. A health `property`, any `reason` or `provenance`, a health `measurement`, a vendor's callback `alternative`, and the order of the generated `services`, `volumes`, `vendors` and each service's `ports`, `mounts` and `dependencies` tables are outside the running stack's identity, and the generated Compose file no longer carries the `x-cockpit-reason`, `x-cockpit-property`, `x-cockpit-measurement` and `x-cockpit-image-reason` annotations. After `sync`, the next `up` reports the stack already running. A change to a service, port, mount or image still makes `up` refuse with `LIFECYCLE_PROGRESS_INVALID` and print the `down`, then `up` recovery.
