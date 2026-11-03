---
"@b00dea/cockpit": patch
---

A second session can no longer take a stack's port lease while a data restore is running on it. Port leasing refused only while a drain was active, so a co-tenant could join mid-restore and break the restore's sole-holder guarantee. It is now refused with `CLAIM_CO_TENANT`.
