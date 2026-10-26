# Testing tiers

<!-- cockpit:verified version=0.0.0 -->

Choose the narrowest product-owned gate that proves the change.

| Tier | Change | Gate and ordered stages |
| --- | --- | --- |
| None | Comments or documentation only, when no behavior changes | No gate required |
| Targeted | Isolated behavior | Select the narrowest proving product gate |
| Full | Shared or cross-system behavior | Run the complete declared product gate |

Extend an existing behavior test at the nearest public boundary when it can prove the change; add a test only when no existing test owns that behavior. Each test must fail when that behavior regresses. Do not duplicate proof already supplied by a stronger test.

Use --select with one typed kind: spec, file, test, or route. Product tooling receives the value as data and owns its native arguments.

Use the targeted gate while iterating. If the declared tier is Full, run the complete gate once after implementation and review stabilize. A targeted tier ends with its declared targeted gate.

Only the complete declared gate can PASS. Subsets and staged selftest are PARTIAL; unavailable checks are DEGRADED; changed subjects are VOID. Executed failures remain FAIL.

All selected stages run. Stack-dependent stages name an unavailable stack. Generated hooks run no tests; call correctness gates explicitly or through CI.
