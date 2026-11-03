---
"@b00dea/cockpit": patch
---

`environment.resettable_volumes` now names volumes by their Compose key, and a name that matches no declared volume is refused.

- `reset` matches each entry against the volume's key in the Compose file within the stack's own Compose project: the `[[environment.generated.volumes]]` `id` in a generated stack, the top-level `volumes:` key in a compose-first stack. It previously compared the entry with Docker's volume name, which carries a per-checkout project prefix, so a committed `resettable_volumes = ["data"]` reset nothing.
- A name no declared volume has is refused instead of skipped: in a generated stack the configuration fails validation; in a compose-first stack `sync`, `check` and every runtime command, `down` included, refuse with `GENERATED_DECLARATION_INVALID` or `GENERATED_ENVIRONMENT_UNAVAILABLE`, naming the declared keys. An `external` volume is refused too, because Compose does not create it and cockpit cannot label it. A declared volume that does not exist yet, or was already removed, is not an error.
- A data volume created under an earlier `cockpit.toml` is still reset, together with any of the stack's containers from that configuration that hold it. The preview still binds the exact volume, labels and generation, so a volume replaced before the approval is refused.
