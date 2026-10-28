---
"@b0dea/cockpit": patch
---

<!-- cockpit:verified version=0.0.0 -->

Keep registry-derived harness execution controls, guard registrations and executable control
directories protected when commands delete, rename, move or directly overwrite them, even when a
declared command rule would otherwise allow the invocation. Apply protected-read checks to bounded
writer sources, fail closed on unsupported archive command shapes, enforce instance and secret
boundaries on direct and containing-directory removals, keep escaped removal sources behind human
approval, and resolve Git move destinations from Git's requested working directory.
