# Testing tiers

<!-- cockpit:verified version=0.0.0 -->

This cockpit declares no product test gate, so no change can be graded PASS.

Before changing behavior, add a characterization test at the nearest public boundary in the product's existing test runner and run it with that runner. If the product has no test runner, propose one to a person; do not add a test framework unasked. Comments or documentation changes that leave behavior unchanged need no test.

Never report work as verified or passing: report which tests you ran and how they exited, and that no gate graded them.

Ask a person to declare `[testing]` stages and gates in cockpit.toml, as the *Choose the proving test tier* section of `./node_modules/@b0dea/cockpit/docs/work-and-browser.md` describes.
