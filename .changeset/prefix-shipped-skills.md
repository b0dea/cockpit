---
"@b0dea/cockpit": minor
---

The shipped skills now carry a `cockpit-` prefix so they do not collide with a project's own skills:
`bootstrap` is `cockpit-setup`, and `explain`, `fix` and `browser` are `cockpit-explain`, `cockpit-fix` and
`cockpit-browser`. `cockpit-setup` now covers an installed cockpit (add a repository, upgrade, diagnose) and
loads the test-data reference; the new experimental `cockpit-work` runs the work-order loop; the evaluator
gains a hunt list for passes that are green for the wrong reason.

Upgrade: run cockpit sync, and update any of your own instructions that name the old skills.
