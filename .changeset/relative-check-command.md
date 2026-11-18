---
"@b00dea/cockpit": patch
---

A work-order check or test stage whose command is a relative path, such as `./node_modules/@b00dea/cockpit/bin/cockpit.mjs`, now runs from the cockpit root as a shell there would. Before, cockpit looked the path up on PATH and reported the command unavailable.
