---
"@b00dea/cockpit": patch
---

Every configuration field now carries a one-sentence description, shown as hover text in editors that read `cockpit.schema.json` and as a Meaning column in the configuration reference. The editor schema now requires `observed_on` and `confirmed` evidence on every provenance table, including those under `browser.runner_health_measurement` and `surfaces.adopted`.
