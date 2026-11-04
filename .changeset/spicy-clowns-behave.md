---
"@b00dea/cockpit": patch
---

Allow init to accept an explicit empty Compose list for staged adoption of a runnable product. It keeps install policies, testing, guards and answer provenance while skipping runtime floor and posture questions; runtime commands continue to report that no runtime is declared. Unattended init also warns about supplied answers when an earlier answer removes their planned questions.
