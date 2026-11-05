---
"@b00dea/cockpit": patch
---

Allow `cockpit env schema --replace-from` to create the first schema in an existing sibling component directory with a regular Git-tracked product file directly inside it. Secret files, protected locations and links cannot authorize a component. Creation does not stage the schema or run its resolvers; discovery requires Git tracking and validation still requires a commit.
