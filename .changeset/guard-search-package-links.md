---
"@b00dea/cockpit": patch
---

A search through a package manager's link inside the cockpit's roots, such as `rg -n pattern node_modules/<package>/docs` where the package directory links into a store in the checkout, is no longer refused. The guard follows the link to its target and judges the search there with the same environment-file and secrets walk as any other search; a target outside the roots stays refused. Listing a directory through such a link (`ls`) is still refused.
