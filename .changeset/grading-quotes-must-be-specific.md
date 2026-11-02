---
"@b0dea/cockpit": patch
---

`work grade` no longer accepts a one-character or repeated quote as evidence. A grader's quote must be at least eight characters (or the whole text it cites) and occur exactly once in the artifact or command output it cites. A shorter or repeated quote matched almost any text, so a grade could read as supported without the grader having observed anything specific. A quote at miscounted character offsets is still accepted.
